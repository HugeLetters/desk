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

export const ProjectSummary = Schema.Struct({ id: Schema.String, name: Schema.String, waiting: Schema.Int, critical: Schema.Int });
export type ProjectSummary = typeof ProjectSummary.Type;

/** The id entries whose project nobody can tell yet (no OpenCode that knows their session is connected) go under. */
export const unknownProject = "unknown";

/** One project's desk, and every project with entries (for switching). */
export const View = Schema.Struct({
	project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
	entries: Schema.Array(Entry),
	projects: Schema.Array(ProjectSummary),
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
);
