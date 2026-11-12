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
import type { SessionID } from "../entry";
import type { Options } from "./connection";

/**
 * OpenCode saying it doesn't know a session. Its own class (`SessionNotFoundError`, `@opencode/protocol/errors`) isn't
 * a dependency of the desk, and `Schema.is` of a class wants an instance of that very class; this matches the error's
 * tag, which holds however it was made.
 */
const SessionNotFound = Schema.Struct({ _tag: Schema.Literal("SessionNotFoundError") });
export const notFound = Schema.is(SessionNotFound);

export type Context = Pick<Plugin.Context, "session">;

/**
 * A session's top-level session: a subagent's desk is its parent's. Parents never change, so it's cached; a failed
 * lookup isn't (OpenCode may answer next time).
 */
export const roots = (ctx: Context) =>
	Effect.gen(function* () {
		const cache: Cache.Cache<SessionID, SessionID, unknown> = yield* Cache.makeWith(
			(sessionID: SessionID) =>
				ctx.session
					.get({ sessionID })
					.pipe(
						Effect.flatMap((session) =>
							session.parentID ? Cache.get(cache, session.parentID) : Effect.succeed(session.id),
						),
					),
			{ capacity: 10_000, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero) },
		);
		return (sessionID: SessionID) => Cache.get(cache, sessionID);
	});

/** The service's calls into this OpenCode: look a session up, deliver a message. */
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
