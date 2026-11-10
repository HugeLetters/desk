/**
 * An entry: one question and its answer, stored as `<store>/<id>.md`. Ids are random UUIDs, never reused and
 * meaning nothing beyond identity; entries are ordered by `created`.
 *
 * ```md
 * ---
 * parent: 3f2b8c1e-…
 * asker: agent
 * status: open
 * session: ses_…          # the root (top-level) session
 * directory: /Users/me/projects/phantom
 * labels: [design, icons]
 * priority: high   # optional: critical | high | normal | low; absent means normal
 * created: 2026-11-07T16:30:00.000Z
 * outbox: msg_…     # optional: the user's text here is not delivered yet; the message it goes out as
 * delivery: queue  # with outbox: queue | steer
 * ---
 *
 * # Which icon?
 *
 * The question, in Markdown.
 *
 * <!-- desk:answer -->
 *
 * The answer, in Markdown.
 * ```
 */
import { SessionID } from "@opencode/schema/session-id";
import { SessionMessage } from "@opencode/schema/session-message";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** An entry's id: a random UUID. Parsed where it comes in (a file name, a request), trusted past that. */
export const EntryId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("EntryId"));
export type EntryId = typeof EntryId.Type;

export { SessionID };
/** The OpenCode message the user's text goes out as. */
export const MessageID = SessionMessage.ID;
export type MessageID = typeof MessageID.Type;

export const Party = Schema.Literals(["user", "agent"]);
export type Party = typeof Party.Type;

/** What the agents set to bump an entry up (or down) the queue; follow-ups start with their parent's. */
export const Priority = Schema.Literals(["critical", "high", "normal", "low"]);
export type Priority = typeof Priority.Type;
const rank = { critical: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * The desk's order: priority first; within a priority, an entry after everything in its own subtree, since the user
 * answers bottom-up (a PR's questions before its review). Each tree is walked post-order (follow-ups by `created`,
 * each before the entry it hangs under), trees by their root's `created`; that walk breaks ties within a priority.
 * Pass the whole desk and filter afterwards: an entry whose parent isn't in `entries` counts as a root.
 */
export function ordered<E extends Pick<Entry, "id" | "parent" | "priority" | "created">>(
	entries: ReadonlyArray<E>,
): Array<E> {
	const byCreated = [...entries].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
	const postOrder = (entry: E): Array<E> => [
		...byCreated.filter((child) => child.parent === entry.id).flatMap(postOrder),
		entry,
	];
	const walked = byCreated.filter((entry) => !entries.some((other) => other.id === entry.parent)).flatMap(postOrder);
	// Entries in a cycle of parents (only a hand-edited file makes one) have no root to be walked from: last.
	const seen = new Set(walked);
	// The sort is stable: within a priority, the walk's order.
	return [...walked, ...byCreated.filter((entry) => !seen.has(entry))].sort(
		(a, b) => rank[a.priority] - rank[b.priority],
	);
}

/** queue: after the session's current turn. steer: into it (urgent). */
export const Delivery = Schema.Literals(["queue", "steer"]);
export type Delivery = typeof Delivery.Type;

/** open: waiting on the answerer. answered: waiting on the asker. resolved: the asker marked it done. */
export const Status = Schema.Literals(["open", "answered", "resolved"]);

/**
 * The user's text on an entry (an answer, or their own question) that hasn't reached the session yet: the message it
 * goes out as, fixed before the first try so a retry is the same message and OpenCode admits it once, and how.
 * Entries sharing a message go out together, as one.
 */
export const Pending = Schema.Struct({ message: MessageID, delivery: Delivery });
export type Pending = typeof Pending.Type;

const Fields = {
	/** An entry's parent, once set, never changes; a top-level entry may be adopted once (never into its own subtree): no cycles, no orphans. */
	parent: Schema.NullOr(EntryId),
	asker: Party,
	status: Status,
	/** The top-level OpenCode session that asked, or that the user's reply belongs to; it hears about the entry. */
	session: SessionID,
	/** Where the asking session works: relative paths in the entry's Markdown resolve against it. */
	directory: Schema.String,
	labels: Schema.Array(Schema.String),
	priority: Priority.pipe(Schema.withDecodingDefaultKey(Effect.succeed("normal" as const))),
	created: Schema.String,
};

/** The file's header: `Fields`, and the pending text flat, as `outbox` (its message) and `delivery`, both or neither. */
const Header = Schema.Struct({
	...Fields,
	outbox: Schema.NullOr(MessageID).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
	delivery: Delivery.pipe(Schema.withDecodingDefaultKey(Effect.succeed("queue" as const))),
});

export const Entry = Schema.Struct({
	...Fields,
	pending: Schema.NullOr(Pending),
	id: EntryId,
	title: Schema.String,
	question: Schema.String,
	answer: Schema.NullOr(Schema.String),
});
export type Entry = typeof Entry.Type;

const decodeHeader = Schema.decodeUnknownOption(Header);
const decodeId = Schema.decodeUnknownOption(EntryId);
const answerMarker = "<!-- desk:answer -->";

export const answerer = (entry: Pick<Entry, "asker">): Party => (entry.asker === "user" ? "agent" : "user");

/**
 * Whose move it is: the answerer while open, the asker while answered, nobody once resolved. What's open below an
 * entry doesn't change that; the desk's order puts it first (a PR's questions before its review).
 */
export const waitingOn = (entry: Pick<Entry, "asker" | "status">): Party | null =>
	entry.status === "resolved" ? null : entry.status === "open" ? answerer(entry) : entry.asker;

/** The entries waiting on `party`, in the desk's order: the page's two groups and its project counts. */
export const waitingFor = (entries: ReadonlyArray<Entry>, party: Party): Array<Entry> =>
	ordered(entries).filter((entry) => waitingOn(entry) === party);

/**
 * Next on the page: the first entry waiting on the user after `current` in the desk's order, wrapping round;
 * undefined when nothing else waits on them (the page then goes back to the list). `current` may have left the desk
 * already: it's placed where it was.
 */
export function next(
	entries: ReadonlyArray<Entry>,
	current: Pick<Entry, "id" | "parent" | "created" | "priority">,
): Entry | undefined {
	const order = ordered([...entries.filter((entry) => entry.id !== current.id), current]);
	const at = order.indexOf(current);
	return [...order.slice(at + 1), ...order.slice(0, at)].find(
		(entry) => entry !== current && waitingOn(entry as Entry) === "user",
	) as Entry | undefined;
}

/** Everything below `root` at depth `from` or deeper (1: its follow-ups), in no particular order. */
export function descendants(entries: ReadonlyArray<Entry>, root: Pick<Entry, "id">, from = 1): ReadonlyArray<Entry> {
	const below = (ids: ReadonlySet<EntryId>, depth: number): Array<Entry> => {
		const children = entries.filter((entry) => entry.parent !== null && ids.has(entry.parent));
		return children.length === 0
			? []
			: [...(depth >= from ? children : []), ...below(new Set(children.map((child) => child.id)), depth + 1)];
	};
	return below(new Set([root.id]), 1);
}

/**
 * Entries deeper than the direct children of `root` (grandchildren and below) that wait on the user, in the desk's order:
 * the unanswered questions a PR review's direct follow-ups don't show.
 */
export function openBelow(entries: ReadonlyArray<Entry>, root: Pick<Entry, "id">): ReadonlyArray<Entry> {
	const below = new Set(descendants(entries, root, 2));
	return ordered(entries).filter((entry) => below.has(entry) && waitingOn(entry) === "user");
}

/** Everything below `root`, at any depth, that is not resolved yet (whoever it waits on), in the desk's order. */
export function openUnder(entries: ReadonlyArray<Entry>, root: Pick<Entry, "id">): ReadonlyArray<Entry> {
	const below = new Set(descendants(entries, root));
	return ordered(entries).filter((entry) => below.has(entry) && entry.status !== "resolved");
}

/** What an entry hangs under, from its root down. */
export function ancestors(entries: ReadonlyArray<Entry>, entry: Pick<Entry, "parent">): ReadonlyArray<Entry> {
	const parent = entries.find((other) => other.id === entry.parent);
	return parent ? [...ancestors(entries, parent), parent] : [];
}

/** What stays on the desk and what leaves it. */
interface Pruned {
	readonly kept: ReadonlyArray<Entry>;
	readonly pruned: ReadonlyArray<Entry>;
}

/**
 * Who leaves the desk once `resolved` is: it, when nothing hangs under it; then its parent, if resolved and left without
 * follow-ups; and so on up. `entries` already holds `resolved`.
 */
export function prune(entries: ReadonlyArray<Entry>, resolved: Entry): Pruned {
	const up = (kept: ReadonlyArray<Entry>, current: Entry | undefined, pruned: ReadonlyArray<Entry>): Pruned =>
		current?.status === "resolved" && !kept.some((other) => other.parent === current.id)
			? up(
					kept.filter((other) => other.id !== current.id),
					kept.find((other) => other.id === current.parent),
					[...pruned, current],
				)
			: { kept, pruned };
	return up(entries, resolved, []);
}

export const newId = () => EntryId.make(crypto.randomUUID());

/**
 * The attachments a text points at, as `[name](/attachments/<uuid>.<ext>)`: the page serves `/attachments/` from the
 * store; `file` is the path below the store.
 */
/** A draft's reference to an attachment it carries, `](attachment:<id>)` in its Markdown (`page/attachments.ts`). */
const attachmentReference = /\]\(attachment:([0-9a-f-]{36})\)/g;
/** The attachment ids a draft's text references. */
export const referencedAttachments = (text: string) =>
	new Set([...text.matchAll(attachmentReference)].flatMap(([, id]) => (id === undefined ? [] : [id])));
/** The text with each attachment reference pointed elsewhere; `to` returns undefined to leave one as it is. */
export const pointAttachments = (text: string, to: (id: string) => string | undefined) =>
	text.replaceAll(attachmentReference, (whole, id: string) => {
		const target = to(id);
		return target === undefined ? whole : `](${target})`;
	});

export const attachmentsIn = (text: string) =>
	[...text.matchAll(/\[([^\]]*)\]\(\/(attachments\/[0-9a-f-]{36}\.[a-z0-9]{1,8})\)/g)].flatMap(([, name, file]) =>
		file === undefined ? [] : [{ name: name || file, file }],
	);

/** The last six hex digits: enough to tell entries apart where the full id is too long to show. */
export const shortId = (id: string) => id.slice(-6);

export const fileName = (id: string) => `${id}.md`;

/** The id an entry file name stands for; other files in the store aren't entries. */
export function idOf(name: string): EntryId | undefined {
	const id = /^(.*)\.md$/.exec(name)?.[1];
	return id === undefined ? undefined : Option.getOrUndefined(decodeId(id));
}

export function serialize(entry: Entry): string {
	const header = [
		`parent: ${entry.parent ?? ""}`.trimEnd(),
		`asker: ${entry.asker}`,
		`status: ${entry.status}`,
		`session: ${entry.session}`,
		`directory: ${JSON.stringify(entry.directory)}`,
		`labels: [${entry.labels.join(", ")}]`,
		...(entry.priority === "normal" ? [] : [`priority: ${entry.priority}`]),
		`created: "${entry.created}"`,
		...(entry.pending === null ? [] : [`outbox: ${entry.pending.message}`, `delivery: ${entry.pending.delivery}`]),
	];
	const answer = entry.answer === null ? [] : [answerMarker, entry.answer];
	return `${["---", ...header, "---"].join("\n")}\n\n${[`# ${entry.title}`, entry.question, ...answer].filter(Boolean).join("\n\n")}\n`;
}

export function parse(id: EntryId, text: string): Option.Option<Entry> {
	const match = /^---\n([\s\S]*?)\n---\n+# (.*)\n?([\s\S]*)$/.exec(text);
	if (!match) return Option.none();
	const [, head, title, body] = match as unknown as [string, string, string, string];
	const [question, answer] = body.split(answerMarker);
	return Option.map(decodeHeader(Bun.YAML.parse(head)), ({ outbox, delivery, ...header }) => ({
		...header,
		pending: outbox === null ? null : { message: outbox, delivery },
		id,
		title: title.trim(),
		question: (question ?? "").trim(),
		answer: answer === undefined ? null : answer.trim(),
	}));
}
