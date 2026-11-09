/** The page's API, served by the service over HTTP (`/rpc`, NDJSON) and called by the page with a typed client. */
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { Entry, Id } from "./entry";
import { DeskError } from "./errors";

export { DeskError };

export const Attachment = Schema.Struct({ id: Schema.String, name: Schema.String, data: Schema.String });
export type Attachment = typeof Attachment.Type;

export const Draft = Schema.Struct({ entry: Id, text: Schema.String, files: Schema.optional(Schema.Array(Attachment)) });
export type Draft = typeof Draft.Type;

/** A project with entries. `guessed`: no connected OpenCode knows its sessions, so it's their folder. */
export const ProjectSummary = Schema.Struct({ id: Schema.String, name: Schema.String, guessed: Schema.Boolean, waiting: Schema.Int, critical: Schema.Int });
export type ProjectSummary = typeof ProjectSummary.Type;

/** One project's desk, every project with entries (for switching), and how many OpenCode instances are connected. */
export const View = Schema.Struct({
	project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String, guessed: Schema.Boolean })),
	entries: Schema.Array(Entry),
	projects: Schema.Array(ProjectSummary),
	/** Connected plugin instances: with none, answers wait and projects are folder guesses. */
	opencode: Schema.Int,
	/** The (top-level) sessions in desk mode, across the connected OpenCode instances. */
	deskMode: Schema.Array(Schema.String),
	/** Outbox (message id) → why its last delivery failed, for undelivered entries whose try failed. */
	failures: Schema.Record(Schema.String, Schema.String),
});
export type View = typeof View.Type;

export const DeskApi = RpcGroup.make(
	/** `project`'s desk now, then after every change; without one, only the project list. */
	Rpc.make("view", { payload: { project: Schema.optional(Schema.String) }, success: View, stream: true }),
	/** Every draft, all or nothing; one queued message per session. Returns how many went. */
	Rpc.make("submit", { payload: { drafts: Schema.Array(Draft) }, success: Schema.Int, error: DeskError }),
	/** One draft, steering its session's current turn. */
	Rpc.make("send", { payload: Draft, error: DeskError }),
	/** The user marks one of their own questions done. */
	Rpc.make("resolve", { payload: { id: Id }, error: DeskError }),
	/** The user gives up on delivering an entry's undelivered text (with the rest of its message); the text stays. */
	Rpc.make("discard", { payload: { entry: Id }, error: DeskError }),
);
