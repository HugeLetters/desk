/**
 * This OpenCode's sessions, as the plugin uses them: telling "no such session" apart from other failures, a session's
 * top-level session (whose desk it asks on), and the service's calls into this OpenCode (`serve`).
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { SessionID } from "../model/entry";
import type { Options } from "./connection";

// TODO main | why not use (`SessionNotFoundError`, `@opencode/protocol/errors`? | by Evgenii Perminov at Sun, 15 Nov 2026 15:38:08 GMT
/**
 * OpenCode saying it doesn't know a session. Its own class (`SessionNotFoundError`, `@opencode/protocol/errors`) isn't
 * a dependency of the desk, and `Schema.is` of a class wants an instance of that very class; this matches the error's
 * tag, which holds however it was made.
 */
const SessionNotFound = Schema.TaggedStruct("SessionNotFoundError", {});
export const notFound = Schema.is(SessionNotFound);

export type Context = Pick<Plugin.Context, "session">;

/**
 * A session's top-level session
 */
export const createRootSessionLookup = Effect.fn("createRootSessionLookup")(function* (ctx: Context) {
	const cache = yield* Cache.makeWith(
		(sessionID: SessionID) =>
			ctx.session.get({ sessionID }).pipe(
				Effect.flatMap((session): Effect.Effect<SessionID, typeof SessionNotFound.Type> => {
					if (!session.parentID) return Effect.succeed(session.id);

					return Cache.get(cache, session.parentID);
				}),
				// TODO main | we should properly pass error here i guess | by Evgenii Perminov at Sun, 15 Nov 2026 15:41:15 GMT
				Effect.catchCause((e) => Effect.fail(SessionNotFound.make({}))),
			),
		{ capacity: 10_000, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero) },
	);

	return (sessionID: SessionID) => Cache.get(cache, sessionID);
});

/** The service's calls into this OpenCode: look a session up, deliver a message. */
// TODO main | no unknown in error channel  | by Evgenii Perminov at Sun, 15 Nov 2026 15:46:33 GMT
export const serve = (ctx: Context): Options["serve"] => ({
	session: (sessionID) =>
		ctx.session.get({ sessionID }).pipe(
			Effect.map((session) => ({
				id: session.id,
				parentID: session.parentID ?? undefined,
				title: session.title ?? "",
				directory: session.location.directory,
			})),
			// Not this OpenCode's session; anything else is an error the service retries.
			Effect.catchIf(notFound, () => Effect.succeed(null)),
		),
	prompt: ({ sessionID, id, text, delivery, files }) =>
		Effect.asVoid(
			ctx.session.prompt({
				sessionID,
				id,
				text,
				delivery,
				files: files.map((file) => ({ uri: file.uri, name: file.name })),
			}),
		),
});
