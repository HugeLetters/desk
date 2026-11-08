import * as Schema from "effect/Schema";

/** A refusal shown as is: on the page, or to the agent as the tool's error. */
export class DeskError extends Schema.TaggedError<DeskError>()("DeskError", { message: Schema.String }) {}
