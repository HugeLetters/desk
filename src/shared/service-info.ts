// TODO main | also shouldnt this be under storage module? right now tests would requires a file system - instead they would just require some sort of storage for service info(which could be fs, sqlite, remote service etc) | by Evgenii Perminov at Sun, 15 Nov 2026 15:34:35 GMT
// TODO main | also its just a strange split that read is here but write is somewhere else | by Evgenii Perminov at Sun, 15 Nov 2026 15:35:57 GMT
/**
 * Running service info storage
 * The running service's files in a store: its registration, `<store>/service.json` (`service/storage/registration.ts`),
 * which says what it is (its pid and protocol) and where its page is, and the log beside it. The registration is the
 * store's lock, read by the service itself; clients find the service by its port, not here.
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
});
export type Info = typeof Info.Type;

/** A registration's text, parsed: fails on anything that isn't one (an empty or half-written file, say). */
export const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Info));
/** A registration's text. */
export const encode = Schema.encodeEffect(Schema.fromJsonString(Info));

/** Where the service's files are in `store`. */
// TODO main | is that good that we have to pass store values from settings through so many layers instead of just reading config here? feels like it can backfire since you can just pass any string here so easy to mess up. shouldnt we just read config here instead? | by Evgenii Perminov at Sun, 15 Nov 2026 14:48:45 GMT
export const files = (store: string) =>
	Effect.map(Path.Path, (path) => ({
		/** The registration. */
		registration: path.join(store, "service.json"),
		/** The service's stdout and stderr, when a plugin started it. */
		log: path.join(store, "service.log"),
	}));

/** The registration in `store` now; none when there's no file or it isn't one. */
// TODO main | same thin about reading store from config | by Evgenii Perminov at Sun, 15 Nov 2026 15:01:52 GMT
export const read = Effect.fnUntraced(function* (store: string) {
	const fs = yield* FileSystem.FileSystem;
	const { registration } = yield* files(store);
	return yield* fs.readFileString(registration).pipe(Effect.flatMap(decode), Effect.option);
});
