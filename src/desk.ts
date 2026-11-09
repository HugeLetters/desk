/**
 * The desk: the rules, over the entries in the store. The files are the only state: every read reads them, and every
 * change reads them, decides and writes, one change at a time (a lock), so edits made to the files by anyone else are
 * simply what the next read finds. `changes` says when to read again: after our own changes, on any file event, and
 * every few seconds besides, in case a file event got lost.
 *
 * The user's text (an answer, or a question of their own) is not sent from here: it's recorded on its entries as an
 * outbox (a message id, fixed now) and `Delivery` takes it to the session from there, as often as it takes, and
 * calls `delivered` once it's in.
 */
import { SessionMessage } from "@opencode/schema/session-message";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AlreadyResolved, EmptyText, HasParent, MissingAttachment, NoSuchEntry, NotTheAnswerer, NotTheAsker, NothingUndelivered, OpenBelow, type Refusal, Undelivered, WouldCycle } from "./errors";
import { answerer, attachmentsIn, type Delivery, descendants, type Entry, type EntryId, type MessageID, newId, type Pending, openUnder, ordered, type Party, type Priority, type SessionID, waitingOn } from "./entry";
import type { Attachment, Draft } from "./page-api";
import { Store } from "./store";

type Entries = ReadonlyArray<Entry>;

export interface Question {
	readonly title: string;
	readonly body: string;
	readonly labels?: ReadonlyArray<string> | undefined;
	/** Omitted with a `pr:<n>` label: the PR's review root, if there is one (see `reviewRoot`). */
	readonly parent?: EntryId | undefined;
	/** Default: the parent's, else normal. */
	readonly priority?: Priority | undefined;
}

/** Who asks: the top-level session (the plugin walks up from a subagent's), and where it works. */
export interface Asker {
	readonly session: SessionID;
	readonly directory: string;
}

/**
 * The newest unresolved top-level entry labelled `review` and the question's `pr:<n>`: where a PR's questions belong.
 * An entry labelled `review` is itself a review root, so it has none. Only entries of `scope` (the asker's project) count.
 */
export function reviewRoot(all: Entries, labels: ReadonlyArray<string>): Entry | undefined {
	if (labels.includes("review")) return undefined;
	return labels
		.filter((label) => /^pr:\d+$/.test(label))
		.flatMap((pr) => all.filter((entry) => entry.parent === null && entry.status !== "resolved" && entry.labels.includes("review") && entry.labels.includes(pr)))
		.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))[0];
}

export class Desk extends Context.Service<
	Desk,
	{
		/** Something may have changed: read again. Once at the start, then after every change, file event and `rescan`. */
		readonly changes: Stream.Stream<void>;
		readonly entries: Effect.Effect<Entries>;
		/**
		 * An agent asks. `scope` is the asker's project: a PR's review root is looked for among those entries only.
		 */
		readonly ask: (asker: Asker, question: Question, scope?: (entry: Entry) => boolean) => Effect.Effect<Entry, Refusal>;
		/** Files a top-level entry under `parent` (not in its own subtree); an entry's parent never changes once set. */
		readonly adopt: (id: EntryId, parent: EntryId) => Effect.Effect<Entry, Refusal>;
		/** An agent answers the user's question. */
		readonly answer: (id: EntryId, body: string) => Effect.Effect<Entry, Refusal>;
		/** Sets an entry's priority, and its whole subtree's when `subtree`. */
		readonly prioritize: (id: EntryId, priority: Priority, subtree: boolean) => Effect.Effect<void, Refusal>;
		/**
		 * The asker marks an entry done (refused while anything below it is unresolved, or while the user's text on it
		 * hasn't reached the session); it leaves the desk once it has no follow-ups, and so on up its parents.
		 */
		readonly resolve: (id: EntryId, by: Party) => Effect.Effect<void, Refusal>;
		/** Unresolved entries of `scope`, one per line, or one entry's thread in full. */
		readonly describe: (id: EntryId | undefined, scope: (entry: Entry) => boolean) => Effect.Effect<string, Refusal>;
		/**
		 * The user's drafts, all or nothing, into the outbox: one message per session. The attachments their texts
		 * reference are stored on the way, and only if every draft is taken. Returns how many were.
		 */
		readonly reply: (drafts: ReadonlyArray<Draft>, delivery: Delivery) => Effect.Effect<number, Refusal>;
		/** `message` reached its session: its entries' text is no longer pending. */
		readonly delivered: (message: MessageID) => Effect.Effect<void>;
		/**
		 * The user gives up on delivering `id`'s undelivered text (its session is gone, say): it and the entries going out
		 * in the same message leave the outbox, keeping their text, and can be resolved.
		 */
		readonly discard: (id: EntryId) => Effect.Effect<void, Refusal>;
	}
>()("desk/Desk") {
	static readonly layer = Desk.layerWith();

	/** `rescan`: how often to read again regardless, should a file event get lost. */
	static layerWith(rescan: Duration.Input = "5 seconds") {
		return Layer.effect(
		this,
		Effect.gen(function* () {
			const store = yield* Store;
			const lock = yield* Semaphore.make(1);
			const ours = yield* PubSub.unbounded<void>();
			/** One change: reads the files, decides (writing what changes), and says so. Changes run one at a time. */
			const modify = <A, E = never>(change: (all: Entries) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
				lock.withPermits(1)(Effect.flatMap(store.load, change)).pipe(Effect.ensuring(PubSub.publish(ours, undefined)));

			const find = (all: Entries, id: string): Effect.Effect<Entry, NoSuchEntry> => {
				const entry = all.find((candidate) => candidate.id === id);
				return entry ? Effect.succeed(entry) : Effect.fail(new NoSuchEntry({ id }));
			};
			const replace = (all: Entries, entry: Entry) =>
				all.some((other) => other.id === entry.id) ? all.map((other) => (other.id === entry.id ? entry : other)) : [...all, entry];

			/** The draft with its `attachment:<id>` references pointed at the files they'll be stored as. One it references but doesn't carry is refused. */
			const attachments = (draft: Draft) =>
				Effect.gen(function* () {
					const uploads: Array<Attachment> = [];
					for (const id of new Set([...draft.text.matchAll(/\]\(attachment:([0-9a-f-]{36})\)/g)].map(([, id]) => id!))) {
						const attachment = draft.files?.find((candidate) => candidate.id === id);
						if (!attachment) return yield* new MissingAttachment({ id: draft.entry, attachment: id });
						uploads.push(attachment);
					}
					return uploads;
				});

			/** The user's draft: the answer when the entry waits on them, otherwise a follow-up question below it. */
			const replyTo = (all: Entries, draft: Draft, pending: Pending): Effect.Effect<Entry, Refusal> =>
				Effect.gen(function* () {
					const entry = yield* find(all, draft.entry);
					const text = draft.text.trim();
					if (!text) return yield* new EmptyText({ id: entry.id });
					if (entry.status === "resolved") return yield* new AlreadyResolved({ id: entry.id });
					if (entry.asker === "agent" && entry.status === "open") return { ...entry, answer: text, status: "answered", pending };
					return {
						id: newId(),
						parent: entry.id,
						asker: "user",
						status: "open",
						session: entry.session,
						directory: entry.directory,
						labels: entry.labels,
						priority: entry.priority,
						created: new Date().toISOString(),
						title: text.split("\n")[0]!.slice(0, 100),
						question: text,
						answer: null,
						pending,
					};
				});

			return Desk.of({
				changes: Stream.concat(
					Stream.make(undefined),
					Stream.mergeAll([Stream.fromPubSub(ours), store.changed, Stream.tick(Duration.fromInputUnsafe(rescan))], { concurrency: "unbounded" }),
				),
				// A store that can't be read is a broken service, not a desk error.
				entries: Effect.orDie(store.load),
				ask: (asker, question, scope = () => true) =>
					modify((all) =>
						Effect.gen(function* () {
							const parent = question.parent === undefined ? reviewRoot(all.filter(scope), question.labels ?? []) : yield* find(all, question.parent);
							const entry: Entry = {
								id: newId(),
								parent: parent?.id ?? null,
								asker: "agent",
								status: "open",
								session: asker.session,
								directory: asker.directory,
								labels: question.labels ?? [],
								priority: question.priority ?? parent?.priority ?? "normal",
								created: new Date().toISOString(),
								title: question.title.trim(),
								question: question.body.trim(),
								answer: null,
								pending: null,
							};
							yield* store.write(entry);
							return entry;
						}),
					),
				adopt: (id, parentID) =>
					modify((all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							yield* find(all, parentID);
							if (entry.parent !== null) return yield* new HasParent({ id, parent: entry.parent });
							if (parentID === id || descendants(all, entry).some((other) => other.id === parentID)) return yield* new WouldCycle({ id, parent: parentID });
							const adopted: Entry = { ...entry, parent: parentID };
							yield* store.write(adopted);
							return adopted;
						}),
					),
				answer: (id, body) =>
					modify((all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							if (entry.asker !== "user") return yield* new NotTheAnswerer({ id, by: "agent" });
							if (entry.status === "resolved") return yield* new AlreadyResolved({ id });
							const answered: Entry = { ...entry, answer: body.trim(), status: "answered" };
							yield* store.write(answered);
							return answered;
						}),
					),
				prioritize: (id, priority, subtree) =>
					modify((all) =>
						Effect.gen(function* () {
							yield* find(all, id);
							const ids = new Set([id, ...(subtree ? descendants(all, { id }).map((entry) => entry.id) : [])]);
							const changed = all.filter((entry) => ids.has(entry.id)).map((entry): Entry => ({ ...entry, priority }));
							yield* Effect.forEach(changed, store.write, { discard: true });
						}),
					),
				resolve: (id, by) =>
					modify((all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							if (entry.asker !== by) return yield* new NotTheAsker({ id, asker: entry.asker });
							if (entry.pending !== null) return yield* new Undelivered({ id });
							const open = openUnder(all, entry);
							if (open.length > 0) return yield* new OpenBelow({ id, below: open.map((other) => other.id) });
							const resolved: Entry = { ...entry, status: "resolved" };
							yield* store.write(resolved);
							// A resolved entry without follow-ups leaves the desk; then its parent may, and so on up.
							let kept = replace(all, resolved);
							const pruned: Array<Entry> = [];
							for (let current: Entry | undefined = resolved; current?.status === "resolved" && !kept.some((other) => other.parent === current!.id); ) {
								yield* store.remove(current.id);
								kept = kept.filter((other) => other.id !== current!.id);
								pruned.push(current);
								current = kept.find((other) => other.id === current!.parent);
							}
							// Attachments only the pruned entries pointed at go with them.
							const texts = (list: Entries) => list.flatMap((other) => attachmentsIn(`${other.question}\n${other.answer ?? ""}`).map(({ file }) => file));
							const still = new Set(texts(kept));
							yield* store.detach(new Set(texts(pruned).filter((file) => !still.has(file))));
						}),
					),
				describe: (id, scope) =>
					Effect.gen(function* () {
						const all = yield* Effect.orDie(store.load);
						if (id === undefined) {
							const mine = all.filter(scope);
							const open = ordered(mine).filter((entry) => entry.status !== "resolved");
							if (open.length === 0) return "The desk is empty: nothing open or waiting.";
							// One short line each: [status, whose turn, priority unless normal, "from the user" for the user's own questions].
							return open
								.map((entry) => {
									const wait = waitingOn(entry, all);
									const tags = [entry.status, wait === "blocked" ? "blocked" : `${wait}'s turn`, ...(entry.priority === "normal" ? [] : [entry.priority]), ...(entry.asker === "user" ? ["from the user"] : [])];
									return `- ${entry.id} ${entry.title} [${tags.join(", ")}]${entry.parent === null ? "" : ` under ${entry.parent}`}`;
								})
								.join("\n");
						}
						// The entry in full; what it hangs under and what hangs under it, one line each (the agent has those bodies, or can ask).
						const entry = yield* find(all, id);
						const above: Array<Entry> = [];
						for (let current = all.find((other) => other.id === entry.parent); current; current = all.find((other) => other.id === current!.parent)) above.unshift(current);
						const line = (other: Entry) => `${other.id} ${other.title} (${other.status})`;
						const followUps = all.filter((other) => other.parent === id);
						return [
							...(above.length ? [`Under: ${above.map(line).join(" › ")}`] : []),
							[`# ${entry.id} ${entry.title}`, `(${entry.status}; asked by the ${entry.asker}, answered by the ${answerer(entry)})`, entry.question, ...(entry.answer === null ? [] : ["## Answer", entry.answer])].join("\n\n"),
							...(followUps.length ? [`Follow-ups: ${followUps.map(line).join("; ")}`] : []),
						].join("\n\n---\n\n");
					}),
				reply: (drafts, delivery) =>
					modify((all) =>
						Effect.gen(function* () {
							// Apply every draft before writing anything, so a refusal leaves the desk (and its attachments) as it was.
							const outboxes = new Map<SessionID, MessageID>();
							let next = all;
							const uploads: Array<{ draft: number; attachment: Attachment }> = [];
							for (const [index, draft] of drafts.entries()) {
								const entry = yield* find(next, draft.entry);
								const message = outboxes.get(entry.session) ?? SessionMessage.ID.create();
								outboxes.set(entry.session, message);
								for (const attachment of yield* attachments(draft)) uploads.push({ draft: index, attachment });
								next = replace(next, yield* replyTo(next, draft, { message, delivery }));
							}
							// Store the files, then point the texts at them.
							const stored: Array<string> = [];
							const links = new Map<string, string>();
							yield* Effect.forEach(uploads, ({ attachment }) =>
								Effect.map(store.attach(attachment.name, Buffer.from(attachment.data, "base64")), (file) => {
									stored.push(file);
									links.set(attachment.id, file);
								}),
							).pipe(Effect.onError(() => store.detach(stored)));
							const link = (text: string) => text.replaceAll(/\]\(attachment:([0-9a-f-]{36})\)/g, (whole, id: string) => (links.has(id) ? `](/${links.get(id)})` : whole));
							next = next.map((entry) => (all.includes(entry) ? entry : { ...entry, question: link(entry.question), answer: entry.answer === null ? null : link(entry.answer) }));
							yield* Effect.forEach(
								next.filter((entry) => !all.includes(entry)),
								store.write,
								{ discard: true },
							);
							return drafts.length;
						}),
					),
				delivered: (message) =>
					modify((all) =>
						Effect.gen(function* () {
							const sent = all.filter((entry) => entry.pending?.message === message).map((entry): Entry => ({ ...entry, pending: null }));
							yield* Effect.forEach(sent, store.write, { discard: true });
						}),
					),
				discard: (id) =>
					modify((all) =>
						Effect.gen(function* () {
							const { pending } = yield* find(all, id);
							if (pending === null) return yield* new NothingUndelivered({ id });
							const held = all.filter((entry) => entry.pending?.message === pending.message).map((entry): Entry => ({ ...entry, pending: null }));
							yield* Effect.forEach(held, store.write, { discard: true });
						}),
					),
			});
		}),
		);
	}
}
