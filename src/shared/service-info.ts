/**
 * The running service's files in a store: its registration, `<store>/service.json` (`service/storage/registration.ts`), which
 * says what it is and where its page and socket are, and the socket and the log beside it. Read by the service itself,
 * the plugin and the TUI badge, with this one schema and these paths.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
/** A registration's text. */
export const encode = Schema.encodeEffect(Schema.fromJsonString(Info));

/** Where the service's files are in `store`. */
export const files = (store: string) =>
	Effect.map(Path.Path, (path) => ({
		/** The registration. */
		registration: path.join(store, "service.json"),
		/** The plugins' socket. */
		socket: path.join(store, "desk.sock"),
		/** The service's stdout and stderr, when a plugin started it. */
		log: path.join(store, "service.log"),
	}));

/** The registration in `store` now; none when there's no file or it isn't one. */
export const read = Effect.fnUntraced(function* (store: string) {
	const fs = yield* FileSystem.FileSystem;
	const { registration } = yield* files(store);
	return yield* fs.readFileString(registration).pipe(Effect.flatMap(decode), Effect.option);
});
