/**
 * This OpenCode's sessions, as the plugin uses them: OpenCode's failures typed, a session's top-level session (whose
 * desk it asks on), and the service's calls into this OpenCode (`serve`).
 */
import type { Plugin } from "@opencode/plugin/effect";
import { SessionNotFoundError } from "@opencode/protocol/errors";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Prompt, SessionInfo } from "../api/api";
import type { SessionID } from "../model/entry";
import { errorMessage } from "./connection";

/**
 * OpenCode saying it doesn't know a session, as {@link SessionNotFoundError}: decoded rather than checked with
 * `instanceof`, so one made by OpenCode's own copy of the class (or as a plain object) becomes this one.
 */
const asNotFound = Schema.decodeUnknownOption(SessionNotFoundError);

/** OpenCode failed for another reason than not knowing the session; `cause` is what it failed with. */
export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
	readonly message: string;
	readonly cause: unknown;
}> {}

/** What OpenCode's session calls fail with: the plugin API types it `unknown`, this tells its not-found apart. */
export type Failure = SessionNotFoundError | OpenCodeError;

const typed = (error: unknown): Failure =>
	Option.getOrElse(asNotFound(error), (): Failure => new OpenCodeError({ message: errorMessage(error), cause: error }));

export interface Context extends Pick<Plugin.Context, "session"> {}

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
