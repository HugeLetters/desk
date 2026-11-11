/**
 * What a desk is called. A desk is a top-level session's (its subagents ask on it too), so it's named after that session:
 * its title and the folder it works in, asked of OpenCode (`session.get`, through a connected plugin instance) and
 * remembered in memory only. A session that moves is asked again, and so is every session whenever a plugin instance
 * connects. One that couldn't be asked (a plugin didn't answer) keeps what was known and is asked again next time.
 *
 * A session no connected OpenCode knows (deleted, or its OpenCode has no session in desk mode) is `known: false`, named
 * after the folder of its entries until one does.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { SessionID } from "./entry";
import { OpenCode, type SessionInfo } from "./opencode";

/** A desk's name. */
export interface Name {
	readonly title: string;
	/** The last segment of the folder the session works in. */
	readonly folder: string;
	/** Whether a connected OpenCode knows the session. */
	readonly known: boolean;
}

interface State {
	/** Top-level session → what OpenCode said of it; null: no connected OpenCode knew it. */
	readonly sessions: ReadonlyMap<SessionID, SessionInfo | null>;
	/** Sessions to ask again (a connect, a move, a lookup that couldn't be made) before what's remembered is used. */
	readonly stale: ReadonlySet<SessionID>;
}

/** What's remembered of a session: the same title and folder count as the same, whatever lookup brought them. */
const sameInfo = (a: SessionInfo | null | undefined, b: SessionInfo | null | undefined) =>
	a === b || (!!a && !!b && a.title === b.title && a.directory === b.directory);
const same = (a: ReadonlyMap<SessionID, SessionInfo | null>, b: ReadonlyMap<SessionID, SessionInfo | null>) =>
	a.size === b.size && [...a].every(([k, v]) => sameInfo(b.get(k), v));

export class Sessions extends Context.Service<
	Sessions,
	{
		/** The name of `session`'s desk; `directory` is where its entries were asked from, for when OpenCode doesn't know it. */
		readonly name: (session: SessionID, directory: string) => Effect.Effect<Name>;
		/** Whenever a name may have changed. */
		readonly changes: Stream.Stream<void>;
	}
>()("desk/Sessions") {
	static get layer() {
		return Layer.effect(
			Sessions,
			Effect.gen(function* () {
				const opencode = yield* OpenCode;
				const path = yield* Path.Path;
				const state = yield* SubscriptionRef.make<State>({ sessions: new Map(), stale: new Set() });
				const staleAll = (pick: (now: State) => Iterable<SessionID>) =>
					SubscriptionRef.update(state, (now) => ({ ...now, stale: new Set([...now.stale, ...pick(now)]) }));

				yield* opencode.moved.pipe(
					Stream.runForEach((session) => staleAll(() => [session])),
					Effect.forkScoped,
				);
				yield* opencode.joined.pipe(
					Stream.runForEach(() => staleAll((now) => now.sessions.keys())),
					Effect.forkScoped,
				);

				const named = (info: SessionInfo | null | undefined, directory: string): Name =>
					info
						? { title: info.title || path.basename(info.directory), folder: path.basename(info.directory), known: true }
						: { title: path.basename(directory), folder: path.basename(directory), known: false };

				return Sessions.of({
					name: (session, directory) =>
						Effect.gen(function* () {
							const now = yield* SubscriptionRef.get(state);
							const remembered = now.sessions.get(session);
							if (remembered !== undefined && !now.stale.has(session)) return named(remembered, directory);
							const lookup = yield* opencode.session(session);
							const info =
								lookup._tag === "Known" ? lookup.session : lookup._tag === "Unknown" ? null : (remembered ?? null);
							yield* SubscriptionRef.update(state, (now) => {
								const stale = new Set(now.stale);
								// Couldn't be asked: what was known stands, and it's asked again next time.
								if (lookup._tag === "Unreachable") stale.add(session);
								else stale.delete(session);
								return { sessions: new Map(now.sessions).set(session, info), stale };
							});
							return named(info, directory);
						}),
					// News: what's known of a session changed, or a session is to be asked again. `name` remembering what it
					// was just told isn't, or every view would be worked out twice.
					changes: SubscriptionRef.changes(state).pipe(
						Stream.changesWith(
							(before, after) =>
								same(before.sessions, after.sessions) && [...after.stale].every((session) => before.stale.has(session)),
						),
						Stream.as(undefined),
					),
				});
			}),
		);
	}
}
