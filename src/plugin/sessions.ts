/**
 * This OpenCode's sessions, as the plugin uses them: OpenCode's failures typed, a session's top-level session (whose
 * desk it asks on), and the service's calls into this OpenCode (`serve`).
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { Prompt, SessionInfo } from "../api/api";
import type { SessionID } from "../model/entry";
import type { Identity } from "../shared/type";
import { errorMessage } from "./connection";

// TODO main | why not use (`SessionNotFoundError`, `@opencode/protocol/errors`? | by Evgenii Perminov at Sun, 15 Nov 2026 15:38:08 GMT
/**
 * OpenCode saying it doesn't know a session. Its own class (`SessionNotFoundError`, `@opencode/protocol/errors`) isn't
 * a dependency of the desk, and `Schema.is` of a class wants an instance of that very class; this matches the error's
 * tag, which holds however it was made.
 */
const SessionNotFound = Schema.TaggedStruct("SessionNotFoundError", { message: Schema.String });
export interface SessionNotFound extends Identity<typeof SessionNotFound.Type> {}
export const notFound = Schema.is(SessionNotFound);

/** OpenCode failed for another reason than not knowing the session; `cause` is what it failed with. */
export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
	readonly message: string;
	readonly cause: unknown;
}> {}

/** What OpenCode's session calls fail with: the plugin API types it `unknown`, this tells its not-found apart. */
export type Failure = SessionNotFound | OpenCodeError;

const typed = (error: unknown): Failure =>
	notFound(error) ? error : new OpenCodeError({ message: errorMessage(error), cause: error });

export type Context = Pick<Plugin.Context, "session">;

/** `ctx.session.get`, failing with a {@link Failure}. */
export const get = (ctx: Context, sessionID: SessionID) => ctx.session.get({ sessionID }).pipe(Effect.mapError(typed));

/** A session's top-level session. */
export const createRootSessionLookup = Effect.fn("createRootSessionLookup")(function* (ctx: Context) {
	const cache = yield* Cache.makeWith(
		(sessionID: SessionID) =>
			get(ctx, sessionID).pipe(
				Effect.flatMap((session): Effect.Effect<SessionID, Failure> => {
					if (!session.parentID) return Effect.succeed(session.id);

					return Cache.get(cache, session.parentID);
				}),
			),
		// Parents never change; a failure isn't kept (OpenCode may answer next time).
		{ capacity: 10_000, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero) },
	);

	return (sessionID: SessionID) => Cache.get(cache, sessionID);
});

/** The service's calls into this OpenCode: look a session up (null when it doesn't know it), deliver a message. */
export const serve = (ctx: Context) => ({
	session: (sessionID: SessionID) =>
		get(ctx, sessionID).pipe(
			Effect.map(
				(session): SessionInfo => ({
					id: session.id,
					parentID: session.parentID ?? undefined,
					title: session.title ?? "",
					directory: session.location.directory,
				}),
			),
			// Not this OpenCode's session; anything else is an error the service retries.
			Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)),
		),
	prompt: (prompt: Prompt) =>
		ctx.session
			.prompt({
				sessionID: prompt.sessionID,
				id: prompt.id,
				text: prompt.text,
				delivery: prompt.delivery,
				files: prompt.files.map((file) => ({ uri: file.uri, name: file.name })),
			})
			.pipe(Effect.asVoid, Effect.mapError(typed)),
});
