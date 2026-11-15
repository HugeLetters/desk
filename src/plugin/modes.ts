/**
 * Desk mode, per top-level session, kept in the plugin's storage as `on/<root session id>` (so a session's subagents
 * follow it), and the connection kept in step with it: connected only while a session in this plugin instance's
 * directory is in desk mode.
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { SessionID } from "../model/entry";
import type { Connection } from "./connection";
import * as Sessions from "./sessions";

export interface Context extends Pick<Plugin.Context, "storage" | "session" | "location"> {}

const prefix = "on/";
const key = (root: SessionID) => `${prefix}${root}`;

export interface Modes {
	/** Whether a session (or the top-level session it's under) is in desk mode. */
	readonly on: (sessionID: SessionID) => Effect.Effect<boolean, Sessions.Failure>;
	/** Turns desk mode on or off for a session's top-level session: on, the top-level session; off, none. */
	readonly toggle: (sessionID: SessionID) => Effect.Effect<Option.Option<SessionID>, Sessions.Failure>;
	/** The sessions in desk mode in this plugin instance's directory, forgetting deleted ones. */
	readonly here: Effect.Effect<ReadonlyArray<SessionID>>;
}

/** Desk mode in `ctx`'s storage; `getRootSessionId` gives a session's top-level session. */
export const make = (
	ctx: Context,
	getRootSessionId: (sessionID: SessionID) => Effect.Effect<SessionID, Sessions.Failure>,
): Modes => ({
	on: (sessionID) =>
		Effect.flatMap(getRootSessionId(sessionID), (rootID) =>
			Effect.map(ctx.storage.get(key(rootID)), (value) => value === true),
		),
	toggle: Effect.fnUntraced(function* (sessionID) {
		const rootID = yield* getRootSessionId(sessionID);
		if ((yield* ctx.storage.get(key(rootID))) === true) {
			yield* ctx.storage.remove(key(rootID));
			return Option.none();
		}

		yield* ctx.storage.set(key(rootID), true);
		return Option.some(rootID);
	}),
	// TODO main | why only in thie directory? | by Evgenii Perminov at Sun, 15 Nov 2026 16:12:22 GMT
	here: Effect.gen(function* () {
		/** Where a session works: in this directory, elsewhere (or OpenCode can't say now), or gone. */
		const where = (sessionID: SessionID) =>
			Sessions.get(ctx, sessionID).pipe(
				Effect.map((session) => (session.location.directory === ctx.location.directory ? "here" : "elsewhere")),
				Effect.catchTag("SessionNotFoundError", () => Effect.succeed("gone" as const)),
				Effect.orElseSucceed(() => "elsewhere" as const),
			);

		const sessions = yield* Stream.paginate(undefined, (after: string | undefined) =>
			Effect.map(ctx.storage.scan({ prefix, after }), (page) => [
				page.entries.map((entry) => SessionID.make(entry.key.slice(prefix.length))),
				Option.fromUndefinedOr(page.next),
			]),
		).pipe(
			Stream.mapEffect((sessionID) => Effect.map(where(sessionID), (at) => ({ sessionID, at }))),
			Stream.runCollect,
		);

		yield* Effect.forEach(
			sessions.filter((session) => session.at === "gone"),
			(session) => ctx.storage.remove(key(session.sessionID)),
		);
		return sessions.filter((session) => session.at === "here").map((session) => session.sessionID);
	}),
});

/**
 * Connects, reports the sessions in desk mode, or hangs up, to match the storage, one change at a time. Connected
 * (and so starting the service) only while a session in this directory is in desk mode: the page counts those
 * sessions, and a plugin instance with none has nothing to ask or deliver. Connecting reports them itself (`attach`
 * reads them), so only a live connection is told.
 */
export const follow = Effect.fn("follow")(function* (modes: Modes, connection: Connection) {
	const lock = yield* Semaphore.make(1);

	// @effect-diagnostics-next-line returnEffectInGen:off
	return Effect.gen(function* () {
		const mine = yield* modes.here;
		if (mine.length === 0) {
			return yield* connection.needsConnection(false);
		}

		const live = yield* connection.live;
		if (Option.isNone(live)) {
			yield* connection.needsConnection(true);
			return;
		}

		yield* Effect.ignore(live.value.modes({ sessions: mine }));
	}).pipe(Semaphore.withPermits(lock, 1));
});
