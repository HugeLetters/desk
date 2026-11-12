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
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
	ancestors,
	answerer,
	attachmentsIn,
	type Delivery,
	descendants,
	type Entry,
	type EntryId,
	type MessageID,
	newId,
	openUnder,
	ordered,
	type Party,
	type Pending,
	type Priority,
	pointAttachments,
	prune,
	referencedAttachments,
	type SessionID,
	waitingOn,
} from "./entry";
import {
	AlreadyResolved,
	EmptyText,
	MissingAttachment,
	NoSuchDesk,
	NoSuchEntry,
	NothingUndelivered,
	OtherDesk,
	type Refusal,
	WouldCycle,
} from "./errors";
import { Event, reconcile } from "./lifecycle";
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
 * An entry labelled `review` is itself a review root, so it has none. Pass the asker's desk: only its entries count.
 */
export function reviewRoot(all: Entries, labels: ReadonlyArray<string>): Entry | undefined {
	if (labels.includes("review")) return undefined;
	return labels
		.filter((label) => /^pr:\d+$/.test(label))
		.flatMap((pr) =>
			all.filter(
				(entry) =>
					entry.parent === null &&
					entry.status !== "resolved" &&
					entry.labels.includes("review") &&
					entry.labels.includes(pr),
			),
		)
		.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))[0];
}

export class Desk extends Context.Service<
	Desk,
	{
		/** Something may have changed: read again. Once at the start, then after every change, file event and `rescan`. */
		readonly changes: Stream.Stream<void>;
		readonly entries: Effect.Effect<Entries>;
		/**
		 * An agent asks, on its session's desk: a PR's review root is looked for there, and a `parent` must be there too.
		 */
		readonly ask: (asker: Asker, question: Question) => Effect.Effect<Entry, Refusal>;
		/**
		 * Files a top-level entry under `parent` (on the same desk, not in its own subtree); an entry's parent never
		 * changes once set.
		 */
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
		/** The unresolved entries of `session`'s desk, one per line, or one entry's thread in full. */
		readonly describe: (id: EntryId | undefined, session: SessionID) => Effect.Effect<string, Refusal>;
		/** `session` takes over `from`'s desk: every entry of `from` becomes `session`'s. Returns how many. */
		readonly claim: (session: SessionID, from: SessionID) => Effect.Effect<number, Refusal>;
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
			Desk,
			Effect.gen(function* () {
				const store = yield* Store;
				const lock = yield* Semaphore.make(1);
				const ours = yield* PubSub.unbounded<void>();
				/** One change: reads the files, decides (writing what changes), and says so. Changes run one at a time. */
				const modify = <A, E = never>(change: (all: Entries) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
					lock
						.withPermits(1)(Effect.flatMap(store.load, change))
						.pipe(Effect.ensuring(PubSub.publish(ours, undefined)));

				const find = (all: Entries, id: string): Effect.Effect<Entry, NoSuchEntry> => {
					const entry = all.find((candidate) => candidate.id === id);
					return entry ? Effect.succeed(entry) : Effect.fail(new NoSuchEntry({ id }));
				};
				/** `event` happens to every one of `entries` (all of them, or, refused, none), and they're written. */
				const each = (entries: Entries, event: Event) =>
					Effect.flatMap(
						Effect.forEach(entries, (entry) => Effect.fromResult(reconcile(entry, event))),
						(after) => Effect.forEach(after, store.write, { discard: true }),
					);
				const replace = (all: Entries, entry: Entry) =>
					all.some((other) => other.id === entry.id)
						? all.map((other) => (other.id === entry.id ? entry : other))
						: [...all, entry];

				/** The draft with its `attachment:<id>` references pointed at the files they'll be stored as. One it references but doesn't carry is refused. */
				const attachments = (draft: Draft) =>
					Effect.forEach(referencedAttachments(draft.text), (id) => {
						const attachment = draft.files?.find((candidate) => candidate.id === id);
						return attachment
							? Effect.succeed(attachment)
							: Effect.fail(new MissingAttachment({ id: draft.entry, attachment: id }));
					});

				/** The user's draft: the answer when the entry waits on them, otherwise a follow-up question below it. */
				const replyTo = (all: Entries, draft: Draft, pending: Pending): Effect.Effect<Entry, Refusal> =>
					Effect.gen(function* () {
						const entry = yield* find(all, draft.entry);
						const text = draft.text.trim();
						if (!text) return yield* new EmptyText({ id: entry.id });
						if (entry.status === "resolved") return yield* new AlreadyResolved({ id: entry.id });
						if (entry.asker === "agent" && entry.status === "open")
							return yield* Effect.fromResult(reconcile(entry, Event.Answer({ by: "user", text, pending })));
						return {
							id: newId(),
							parent: entry.id,
							asker: "user",
							status: "open",
							session: entry.session,
							directory: entry.directory,
							labels: entry.labels,
							priority: entry.priority,
							created: DateTime.formatIso(yield* DateTime.now),
							title: text.replace(/\n[\s\S]*$/, "").slice(0, 100),
							question: text,
							answer: null,
							pending,
						};
					});

				return Desk.of({
					changes: Stream.concat(
						Stream.make(undefined),
						Stream.mergeAll([Stream.fromPubSub(ours), store.changed, Stream.tick(rescan)], {
							concurrency: "unbounded",
						}),
					),
					// A store that can't be read is a broken service, not a desk error.
					entries: Effect.orDie(store.load),
					ask: (asker, question) =>
						modify((all) =>
							Effect.gen(function* () {
								const parent =
									question.parent === undefined
										? reviewRoot(
												all.filter((entry) => entry.session === asker.session),
												question.labels ?? [],
											)
										: yield* find(all, question.parent);
								if (parent && parent.session !== asker.session) return yield* new OtherDesk({ id: parent.id });
								const entry: Entry = {
									id: newId(),
									parent: parent?.id ?? null,
									asker: "agent",
									status: "open",
									session: asker.session,
									directory: asker.directory,
									labels: question.labels ?? [],
									priority: question.priority ?? parent?.priority ?? "normal",
									created: DateTime.formatIso(yield* DateTime.now),
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
								const parent = yield* find(all, parentID);
								const adopted = yield* Effect.fromResult(reconcile(entry, Event.Adopt({ parent: parentID })));
								if (parent.session !== entry.session) return yield* new OtherDesk({ id: parentID });
								if (parentID === id || descendants(all, entry).some((other) => other.id === parentID))
									return yield* new WouldCycle({ id, parent: parentID });
								yield* store.write(adopted);
								return adopted;
							}),
						),
					answer: (id, body) =>
						modify((all) =>
							Effect.gen(function* () {
								const entry = yield* find(all, id);
								const answered = yield* Effect.fromResult(
									reconcile(entry, Event.Answer({ by: "agent", text: body.trim() })),
								);
								yield* store.write(answered);
								return answered;
							}),
						),
					prioritize: (id, priority, subtree) =>
						modify((all) =>
							Effect.gen(function* () {
								yield* find(all, id);
								const ids = new Set([id, ...(subtree ? descendants(all, { id }).map((entry) => entry.id) : [])]);
								yield* each(
									all.filter((entry) => ids.has(entry.id)),
									Event.Prioritize({ priority }),
								);
							}),
						),
					resolve: (id, by) =>
						modify((all) =>
							Effect.gen(function* () {
								const entry = yield* find(all, id);
								const resolved = yield* Effect.fromResult(
									reconcile(entry, Event.Resolve({ by, openBelow: openUnder(all, entry).map((other) => other.id) })),
								);
								yield* store.write(resolved);
								// A resolved entry without follow-ups leaves the desk; then its parent may, and so on up.
								const { kept, pruned } = prune(replace(all, resolved), resolved);
								yield* Effect.forEach(pruned, (gone) => store.remove(gone.id), { discard: true });
								// Attachments only the pruned entries pointed at go with them.
								const texts = (list: Entries) =>
									list.flatMap((other) =>
										attachmentsIn(`${other.question}\n${other.answer ?? ""}`).map(({ file }) => file),
									);
								const still = new Set(texts(kept));
								yield* store.detach(new Set(texts(pruned).filter((file) => !still.has(file))));
							}),
						),
					claim: (session, from) =>
						modify((all) =>
							Effect.gen(function* () {
								const theirs = all.filter((entry) => entry.session === from);
								if (theirs.length === 0) return yield* new NoSuchDesk({ session: from });
								yield* each(theirs, Event.Claim({ session }));
								return theirs.length;
							}),
						),
					describe: (id, session) =>
						Effect.gen(function* () {
							const all = yield* Effect.orDie(store.load);
							if (id === undefined) {
								const mine = all.filter((entry) => entry.session === session);
								const open = ordered(mine).filter((entry) => entry.status !== "resolved");
								if (open.length === 0) return "The desk is empty: nothing open or waiting.";
								// One short line each: [status, whose turn, priority unless normal, "from the user" for the user's own questions].
								return open
									.map((entry) => {
										const tags = [
											entry.status,
											`${waitingOn(entry)}'s turn`,
											...(entry.priority === "normal" ? [] : [entry.priority]),
											...(entry.asker === "user" ? ["from the user"] : []),
										];
										return `- ${entry.id} ${entry.title} [${tags.join(", ")}]${entry.parent === null ? "" : ` under ${entry.parent}`}`;
									})
									.join("\n");
							}
							// The entry in full; what it hangs under and what hangs under it, one line each (the agent has those bodies, or can ask).
							const entry = yield* find(all, id);
							const above = ancestors(all, entry);
							const line = (other: Entry) => `${other.id} ${other.title} (${other.status})`;
							const followUps = all.filter((other) => other.parent === id);
							return [
								...(above.length ? [`Under: ${above.map(line).join(" › ")}`] : []),
								[
									`# ${entry.id} ${entry.title}`,
									`(${entry.status}; asked by the ${entry.asker}, answered by the ${answerer(entry)})`,
									entry.question,
									...(entry.answer === null ? [] : ["## Answer", entry.answer]),
								].join("\n\n"),
								...(followUps.length ? [`Follow-ups: ${followUps.map(line).join("; ")}`] : []),
							].join("\n\n---\n\n");
						}),
					reply: (drafts, delivery) =>
						modify((all) =>
							Effect.gen(function* () {
								// Apply every draft before writing anything, so a refusal leaves the desk (and its attachments) as it was.
								// One message per session.
								const plan = yield* Effect.reduce(
									drafts,
									() => ({
										next: all,
										outboxes: new Map() as ReadonlyMap<SessionID, MessageID>,
										uploads: [] as ReadonlyArray<Attachment>,
									}),
									(plan, draft) =>
										Effect.gen(function* () {
											const entry = yield* find(plan.next, draft.entry);
											const message = plan.outboxes.get(entry.session) ?? SessionMessage.ID.create();
											const uploads = yield* attachments(draft);
											const reply = yield* replyTo(plan.next, draft, { message, delivery });
											return {
												next: replace(plan.next, reply),
												outboxes: new Map(plan.outboxes).set(entry.session, message),
												uploads: [...plan.uploads, ...uploads],
											};
										}),
								);
								// Store the files (all of them, or none: a failure removes those already stored), then point the texts
								// at them.
								const links = new Map(
									yield* Effect.scoped(
										Effect.forEach(plan.uploads, (attachment) =>
											Effect.acquireRelease(store.attach(attachment.name, attachment.data), (file, exit) =>
												Exit.isFailure(exit) ? store.detach([file]) : Effect.void,
											).pipe(Effect.map((file) => [attachment.id, file] as const)),
										),
									),
								);
								const link = (text: string) =>
									pointAttachments(text, (id) => (links.has(id) ? `/${links.get(id)}` : undefined));
								const next = plan.next.map((entry) =>
									all.includes(entry)
										? entry
										: {
												...entry,
												question: link(entry.question),
												answer: entry.answer === null ? null : link(entry.answer),
											},
								);
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
							// Delivery is never refused.
							Effect.orDie(
								each(
									all.filter((entry) => entry.pending?.message === message),
									Event.Delivered(),
								),
							),
						),
					discard: (id) =>
						modify((all) =>
							Effect.gen(function* () {
								const { pending } = yield* find(all, id);
								if (pending === null) return yield* new NothingUndelivered({ id });
								yield* each(
									all.filter((entry) => entry.pending?.message === pending.message),
									Event.Discard(),
								);
							}),
						),
				});
			}),
		);
	}
}
