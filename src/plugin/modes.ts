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
import { notFound } from "./sessions";

export type Context = Pick<Plugin.Context, "storage" | "session" | "location">;

const prefix = "on/";
const key = (root: SessionID) => `${prefix}${root}`;

export interface Modes {
	/** Whether a session (or the top-level session it's under) is in desk mode. */
	readonly on: (sessionID: SessionID) => Effect.Effect<boolean, unknown>;
	/** Turns desk mode on or off for a session's top-level session: on, the top-level session; off, none. */
	readonly toggle: (sessionID: SessionID) => Effect.Effect<Option.Option<SessionID>, unknown>;
	/** The sessions in desk mode in this plugin instance's directory, forgetting deleted ones. */
	readonly here: Effect.Effect<ReadonlyArray<SessionID>>;
}

/** Desk mode in `ctx`'s storage; `root` gives a session's top-level session. */
export const make = (ctx: Context, root: (sessionID: SessionID) => Effect.Effect<SessionID, unknown>): Modes => ({
	on: (sessionID) =>
		Effect.flatMap(root(sessionID), (rootID) => Effect.map(ctx.storage.get(key(rootID)), (value) => value === true)),
	toggle: (sessionID) =>
		Effect.gen(function* () {
			const rootID = yield* root(sessionID);
			if ((yield* ctx.storage.get(key(rootID))) === true) {
				yield* ctx.storage.remove(key(rootID));
				return Option.none();
			}
			yield* ctx.storage.set(key(rootID), true);
			return Option.some(rootID);
		}),
	here: Effect.gen(function* () {
		const sessions = yield* Stream.paginate(undefined as string | undefined, (after) =>
			Effect.map(ctx.storage.scan({ prefix, after }), (page) => [
				page.entries.map((entry) => SessionID.make(entry.key.slice(prefix.length))),
				Option.fromUndefinedOr(page.next),
			]),
		).pipe(Stream.runCollect);
		const where = yield* Effect.forEach(sessions, (id) =>
			ctx.session.get({ sessionID: id }).pipe(
				Effect.map((session) => (session.location.directory === ctx.location.directory ? "here" : "elsewhere")),
				Effect.catchIf(notFound, () => Effect.succeed("gone" as const)),
				Effect.orElseSucceed(() => "elsewhere" as const),
			),
		);
		yield* Effect.forEach(
			sessions.filter((_, index) => where[index] === "gone"),
			(id) => ctx.storage.remove(key(id)),
		);
		return sessions.filter((_, index) => where[index] === "here");
	}),
});

/**
 * Connects, reports the sessions in desk mode, or hangs up, to match the storage, one change at a time. Connected
 * (and so starting the service) only while a session in this directory is in desk mode: the page counts those
 * sessions, and a plugin instance with none has nothing to ask or deliver. Connecting reports them itself (`attach`
 * reads them), so only a live connection is told.
 */
export const follow = (modes: Modes, connection: Connection) =>
	Effect.map(Semaphore.make(1), (lock) =>
		Semaphore.withPermits(
			lock,
			1,
		)(
			Effect.gen(function* () {
				const mine = yield* modes.here;
				if (mine.length === 0) return yield* connection.want(false);
				const live = yield* connection.live;
				if (Option.isSome(live)) yield* Effect.ignore(live.value.modes({ sessions: mine }));
				else yield* connection.want(true);
			}),
		),
	);
