/**
 * The desk: every entry in the store, kept in a `SubscriptionRef`; each change is written to its file inside the
 * update. Edits made to the files by someone else are taken in as they happen.
 *
 * The user's text (an answer, or a question of their own) is not sent from here: it's recorded on its entries as an
 * outbox (a message id, fixed now) and `Delivery` takes it to the session from there, as often as it takes, and
 * calls `delivered` once it's in.
 */
import { SessionMessage } from "@opencode/schema/session-message";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { DeskError } from "./errors";
import { answerer, attachmentsIn, type Delivery, descendants, type Entry, newId, openUnder, ordered, type Party, type Priority, waitingOn } from "./entry";
import { Store } from "./store";

type Entries = ReadonlyArray<Entry>;

export interface Question {
	readonly title: string;
	readonly body: string;
	readonly labels?: ReadonlyArray<string> | undefined;
	/** Omitted with a `pr:<n>` label: the PR's review root, if there is one (see `reviewRoot`). */
	readonly parent?: string | undefined;
	/** Default: the parent's, else normal. */
	readonly priority?: Priority | undefined;
}

/** Who asks: the top-level session (the plugin walks up from a subagent's), and where it works. */
export interface Asker {
	readonly session: string;
	readonly directory: string;
}

/**
 * A file the user attached to a draft, kept in the browser until the draft is sent: `id` is the draft-local name its
 * Markdown uses, `attachment:<id>`; `data` the bytes, base64.
 */
export interface Attachment {
	readonly id: string;
	readonly name: string;
	readonly data: string;
}

/**
 * The user's text for an entry: an answer, or (on their own question) a follow-up. `files` holds the attachments the
 * text references; sending stores them as `attachments/<uuid>.<ext>` and points the text at `/attachments/…`.
 */
export interface Draft {
	readonly entry: string;
	readonly text: string;
	readonly files?: ReadonlyArray<Attachment> | undefined;
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
		/** The entries now, then after every change, by `created`. */
		readonly changes: Stream.Stream<Entries>;
		readonly entries: Effect.Effect<Entries>;
		/**
		 * An agent asks. `scope` is the asker's project: a PR's review root is looked for among those entries only.
		 */
		readonly ask: (asker: Asker, question: Question, scope?: (entry: Entry) => boolean) => Effect.Effect<Entry, DeskError>;
		/** Files a top-level entry under `parent` (not in its own subtree); an entry's parent never changes once set. */
		readonly adopt: (id: string, parent: string) => Effect.Effect<Entry, DeskError>;
		/** An agent answers the user's question. */
		readonly answer: (id: string, body: string) => Effect.Effect<Entry, DeskError>;
		/** Sets an entry's priority, and its whole subtree's when `subtree`. */
		readonly prioritize: (id: string, priority: Priority, subtree: boolean) => Effect.Effect<void, DeskError>;
		/**
		 * The asker marks an entry done (refused while anything below it is unresolved, or while the user's text on it
		 * hasn't reached the session); it leaves the desk once it has no follow-ups, and so on up its parents.
		 */
		readonly resolve: (id: string, by: Party) => Effect.Effect<void, DeskError>;
		/** Unresolved entries of `scope`, one per line, or one entry's thread in full. */
		readonly describe: (id: string | undefined, scope: (entry: Entry) => boolean) => Effect.Effect<string, DeskError>;
		/**
		 * The user's drafts, all or nothing, into the outbox: one message per session. The attachments their texts
		 * reference are stored on the way, and only if every draft is taken. Returns how many were.
		 */
		readonly reply: (drafts: ReadonlyArray<Draft>, delivery: Delivery) => Effect.Effect<number, DeskError>;
		/** The message `outbox` reached its session: its entries leave the outbox. */
		readonly delivered: (outbox: string) => Effect.Effect<void, DeskError>;
	}
>()("desk/Desk") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const store = yield* Store;
			const entries = yield* SubscriptionRef.make<Entries>(yield* store.load);

			// Someone else edited a file: take it in (or drop the entry, once its file is gone).
			yield* store.edits.pipe(
				Stream.runForEach(({ id, entry }) =>
					SubscriptionRef.update(entries, (all) => {
						const rest = all.filter((other) => other.id !== id);
						return entry === null ? rest : [...rest, entry].sort((a, b) => a.created.localeCompare(b.created));
					}),
				),
				Effect.forkScoped,
			);

			const find = (all: Entries, id: string) => {
				const entry = all.find((candidate) => candidate.id === id);
				return entry ? Effect.succeed(entry) : Effect.fail(new DeskError({ message: `No desk entry ${id}.` }));
			};
			const replace = (all: Entries, entry: Entry) =>
				all.some((other) => other.id === entry.id) ? all.map((other) => (other.id === entry.id ? entry : other)) : [...all, entry];

			/** The draft with its `attachment:<id>` references pointed at the files they'll be stored as. One it references but doesn't carry is refused. */
			const attachments = (draft: Draft) =>
				Effect.gen(function* () {
					const uploads: Array<Attachment> = [];
					for (const id of new Set([...draft.text.matchAll(/\]\(attachment:([0-9a-f-]{36})\)/g)].map(([, id]) => id!))) {
						const attachment = draft.files?.find((candidate) => candidate.id === id);
						if (!attachment) return yield* new DeskError({ message: `Entry ${draft.entry}: attachment ${id} is missing from the draft; attach the file again.` });
						uploads.push(attachment);
					}
					return uploads;
				});

			/** The user's draft: the answer when the entry waits on them, otherwise a follow-up question below it. */
			const replyTo = (all: Entries, draft: Draft, outbox: string, delivery: Delivery): Effect.Effect<Entry, DeskError> =>
				Effect.gen(function* () {
					const entry = yield* find(all, draft.entry);
					const text = draft.text.trim();
					if (!text) return yield* new DeskError({ message: `Entry ${entry.id}: the text is empty.` });
					if (entry.status === "resolved") return yield* new DeskError({ message: `Entry ${entry.id} is already resolved.` });
					if (entry.asker === "agent" && entry.status === "open") return { ...entry, answer: text, status: "answered", outbox, delivery };
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
						outbox,
						delivery,
					};
				});

			return Desk.of({
				changes: SubscriptionRef.changes(entries),
				entries: SubscriptionRef.get(entries),
				ask: (asker, question, scope = () => true) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
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
								outbox: null,
								delivery: null,
							};
							yield* store.write(entry);
							return [entry, [...all, entry]] as const;
						}),
					),
				adopt: (id, parentID) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							yield* find(all, parentID);
							if (entry.parent !== null) return yield* new DeskError({ message: `Entry ${id} already has a parent (${entry.parent}); a parent never changes.` });
							if (parentID === id || descendants(all, entry).some((other) => other.id === parentID)) return yield* new DeskError({ message: `Entry ${parentID} is in the subtree of ${id}; adopting it there would make a cycle.` });
							const adopted: Entry = { ...entry, parent: parentID };
							yield* store.write(adopted);
							return [adopted, replace(all, adopted)] as const;
						}),
					),
				answer: (id, body) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							if (entry.asker !== "user") return yield* new DeskError({ message: `Entry ${id} is the agents' own question; the user answers it.` });
							if (entry.status === "resolved") return yield* new DeskError({ message: `Entry ${id} is already resolved.` });
							const answered: Entry = { ...entry, answer: body.trim(), status: "answered" };
							yield* store.write(answered);
							return [answered, replace(all, answered)] as const;
						}),
					),
				prioritize: (id, priority, subtree) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							yield* find(all, id);
							const ids = new Set([id, ...(subtree ? descendants(all, { id }).map((entry) => entry.id) : [])]);
							const changed = all.filter((entry) => ids.has(entry.id)).map((entry): Entry => ({ ...entry, priority }));
							yield* Effect.forEach(changed, store.write);
							return [undefined, all.map((entry) => changed.find((other) => other.id === entry.id) ?? entry)] as const;
						}),
					),
				resolve: (id, by) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							const entry = yield* find(all, id);
							if (entry.asker !== by) return yield* new DeskError({ message: `Entry ${id} was asked by the ${entry.asker}; only the asker marks it done.` });
							if (entry.outbox !== null) return yield* new DeskError({ message: `Entry ${id}: the user's text on it hasn't reached the session yet, so it can't be resolved yet.` });
							const open = openUnder(all, entry);
							if (open.length > 0) return yield* new DeskError({ message: `Entry ${id} still has ${open.length} open below it, so it can't be resolved yet: ${open.map((other) => other.id).join(", ")}.` });
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
							return [undefined, kept] as const;
						}),
					),
				describe: (id, scope) =>
					Effect.gen(function* () {
						const all = yield* SubscriptionRef.get(entries);
						if (id === undefined) {
							const mine = all.filter(scope);
							const open = ordered(mine).filter((entry) => entry.status !== "resolved");
							if (open.length === 0) return "The desk is empty: nothing open or waiting.";
							return open
								.map((entry) => {
									const parent = entry.parent === null ? "" : ` (follow-up to ${entry.parent})`;
									const priority = entry.priority === "normal" ? "" : `, ${entry.priority} priority`;
									const wait = waitingOn(entry, all);
									const turn = wait === "blocked" ? "blocked by its unresolved follow-ups" : `waiting on the ${wait}`;
									return `- ${entry.id} ${entry.title}${parent} — ${entry.status}${priority}, ${turn}, asked by the ${entry.asker}`;
								})
								.join("\n");
						}
						const thread: Array<Entry> = [];
						for (let current: Entry | undefined = yield* find(all, id); current; current = all.find((entry) => entry.id === current!.parent)) thread.unshift(current);
						const followUps = all.filter((entry) => entry.parent === id).map((entry) => `${entry.id} ${entry.title} (${entry.status})`);
						return [
							...thread.map((entry) =>
								[`# ${entry.id} ${entry.title}`, `(${entry.status}; asked by the ${entry.asker}, answered by the ${answerer(entry)})`, entry.question, ...(entry.answer === null ? [] : ["## Answer", entry.answer])].join("\n\n"),
							),
							...(followUps.length ? [`Follow-ups: ${followUps.join("; ")}`] : []),
						].join("\n\n---\n\n");
					}),
				reply: (drafts, delivery) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							// Apply every draft before writing anything, so a refusal leaves the desk (and its attachments) as it was.
							const outboxes = new Map<string, string>();
							let next = all;
							const uploads: Array<{ draft: number; attachment: Attachment }> = [];
							for (const [index, draft] of drafts.entries()) {
								const entry = yield* find(next, draft.entry);
								const outbox = outboxes.get(entry.session) ?? SessionMessage.ID.create();
								outboxes.set(entry.session, outbox);
								for (const attachment of yield* attachments(draft)) uploads.push({ draft: index, attachment });
								next = replace(next, yield* replyTo(next, draft, outbox, delivery));
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
							);
							return [drafts.length, next] as const;
						}),
					),
				delivered: (outbox) =>
					SubscriptionRef.modifyEffect(entries, (all) =>
						Effect.gen(function* () {
							const sent = all.filter((entry) => entry.outbox === outbox).map((entry): Entry => ({ ...entry, outbox: null, delivery: null }));
							yield* Effect.forEach(sent, store.write);
							return [undefined, all.map((entry) => sent.find((other) => other.id === entry.id) ?? entry)] as const;
						}),
					),
			});
		}),
	);
}
