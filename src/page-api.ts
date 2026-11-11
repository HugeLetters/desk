/** The page's API, served by the service over HTTP (`/rpc`, NDJSON) and called by the page with a typed client. */
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { Entry, EntryId } from "./entry";
import { DeliveryFailed, Refusal } from "./errors";

/** An attachment the page sends: its bytes, base64 on the wire. */
export const Attachment = Schema.Struct({ id: Schema.String, name: Schema.String, data: Schema.Uint8ArrayFromBase64 });
export type Attachment = typeof Attachment.Type;

/**
 * The user's text for an entry: an answer, or (on their own question) a follow-up. `files` holds the attachments the
 * text references (`attachment:<id>` in its Markdown); sending stores them as `attachments/<uuid>.<ext>`.
 */
export const Draft = Schema.Struct({
	entry: EntryId,
	text: Schema.String,
	files: Schema.optional(Schema.Array(Attachment)),
});
export type Draft = typeof Draft.Type;

/** A desk: a top-level session's, named after it (`sessions.ts`). */
export const DeskName = Schema.Struct({
	session: Schema.String,
	title: Schema.String,
	/** The last segment of the folder the session works in. */
	folder: Schema.String,
	/** Whether a connected OpenCode knows the session; one nobody knows may be gone, and its desk can be claimed. */
	known: Schema.Boolean,
});
export type DeskName = typeof DeskName.Type;

/** A desk with entries, for the list: how many wait on the user, and how many of those are critical. */
export const DeskSummary = Schema.Struct({ ...DeskName.fields, waiting: Schema.Int, critical: Schema.Int });
export type DeskSummary = typeof DeskSummary.Type;

/** One session's desk, every desk with entries (for switching), and the sessions in desk mode. */
export const View = Schema.Struct({
	desk: Schema.NullOr(DeskName),
	entries: Schema.Array(Entry),
	desks: Schema.Array(DeskSummary),
	/** The (top-level) sessions in desk mode, across the connected OpenCode instances. */
	deskMode: Schema.Array(Schema.String),
	/** Outbox (message id) → why its last delivery failed, for undelivered entries whose try failed. */
	failures: Schema.Record(Schema.String, DeliveryFailed),
});
export type View = typeof View.Type;

export const DeskApi = RpcGroup.make(
	/** `session`'s desk now, then after every change; without one, only the list of desks. */
	Rpc.make("view", { payload: { session: Schema.optional(Schema.String) }, success: View, stream: true }),
	/** Every draft, all or nothing; one queued message per session. Returns how many went. */
	Rpc.make("submit", { payload: { drafts: Schema.Array(Draft) }, success: Schema.Int, error: Refusal }),
	/** One draft, steering its session's current turn. */
	Rpc.make("send", { payload: Draft, error: Refusal }),
	/** The user marks one of their own questions done. */
	Rpc.make("resolve", { payload: { id: EntryId }, error: Refusal }),
	/** The user gives up on delivering an entry's undelivered text (with the rest of its message); the text stays. */
	Rpc.make("discard", { payload: { entry: EntryId }, error: Refusal }),
);
