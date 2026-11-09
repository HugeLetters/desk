/** The page's API, served by the service over HTTP (`/rpc`, NDJSON) and called by the page with a typed client. */
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { Entry, EntryId } from "./entry";
import { DeliveryFailed, Refusal } from "./errors";
import { Placement } from "./placement";

export const Attachment = Schema.Struct({ id: Schema.String, name: Schema.String, data: Schema.String });
export type Attachment = typeof Attachment.Type;

/**
 * The user's text for an entry: an answer, or (on their own question) a follow-up. `files` holds the attachments the
 * text references (`attachment:<id>` in its Markdown, `data` base64); sending stores them as `attachments/<uuid>.<ext>`.
 */
export const Draft = Schema.Struct({ entry: EntryId, text: Schema.String, files: Schema.optional(Schema.Array(Attachment)) });
export type Draft = typeof Draft.Type;

/** A project with entries. `id` is its placement's key (its URL); a `Folder` is a guess: no connected OpenCode knows its sessions. */
export const ProjectSummary = Schema.Struct({ id: Schema.String, name: Schema.String, placement: Placement, waiting: Schema.Int, critical: Schema.Int });
export type ProjectSummary = typeof ProjectSummary.Type;

/** One project's desk, every project with entries (for switching), and how many OpenCode instances are connected. */
export const View = Schema.Struct({
	project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String, placement: Placement })),
	entries: Schema.Array(Entry),
	projects: Schema.Array(ProjectSummary),
	/** The (top-level) sessions in desk mode, across the connected OpenCode instances. */
	deskMode: Schema.Array(Schema.String),
	/** Outbox (message id) → why its last delivery failed, for undelivered entries whose try failed. */
	failures: Schema.Record(Schema.String, DeliveryFailed),
});
export type View = typeof View.Type;

export const DeskApi = RpcGroup.make(
	/** `project`'s desk now, then after every change; without one, only the project list. */
	Rpc.make("view", { payload: { project: Schema.optional(Schema.String) }, success: View, stream: true }),
	/** Every draft, all or nothing; one queued message per session. Returns how many went. */
	Rpc.make("submit", { payload: { drafts: Schema.Array(Draft) }, success: Schema.Int, error: Refusal }),
	/** One draft, steering its session's current turn. */
	Rpc.make("send", { payload: Draft, error: Refusal }),
	/** The user marks one of their own questions done. */
	Rpc.make("resolve", { payload: { id: EntryId }, error: Refusal }),
	/** The user gives up on delivering an entry's undelivered text (with the rest of its message); the text stays. */
	Rpc.make("discard", { payload: { entry: EntryId }, error: Refusal }),
);
