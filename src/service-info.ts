/**
 * `<store>/service.json`, the running service's registration (`service/registration.ts`): what it is and where its
 * page and socket are. Read by the service itself and by the TUI badge, with this one schema.
 */
import * as Schema from "effect/Schema";

export const Info = Schema.Struct({
	pid: Schema.Int,
	protocol: Schema.String,
	/** Once the page is up. */
	url: Schema.optional(Schema.String),
	socket: Schema.optional(Schema.String),
});
export type Info = typeof Info.Type;

/** A registration's text, parsed: fails on anything that isn't one (an empty or half-written file, say). */
export const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Info));
export const encode = Schema.encodeSync(Schema.fromJsonString(Info));
