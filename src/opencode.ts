/**
 * OpenCode, as far as the service needs it: the OpenCode instances whose plugin is connected right now, the sessions
 * they know, a way to prompt one, and the sessions that move to another project.
 *
 * The service never calls OpenCode itself. Each connected plugin instance is a `Client`: it looks sessions up and
 * prompts them in its own OpenCode for the service (over the socket), and reports the sessions that move there. So
 * the service needs no endpoint or password, and a session is reachable exactly while a plugin instance of an
 * OpenCode that knows it is connected. Tests attach fakes.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { SessionID } from "./entry";
import { DeliveryFailed } from "./errors";
import type { Prompt, SessionInfo } from "./protocol";

export type { Prompt, SessionInfo };

/**
 * What the attached OpenCode instances say about a session: one knows it; all of them answered and none does; or none
 * knows it and one couldn't answer, so it may yet. Only `Unknown` is an answer to remember.
 */
export type Lookup = Data.TaggedEnum<{
	Known: { readonly session: SessionInfo };
	// biome-ignore lint/complexity/noBannedTypes: a TaggedEnum member without fields is `{}`.
	Unknown: {};
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Unreachable: {};
}>;
export const Lookup = Data.taggedEnum<Lookup>();

/** The plugin instance couldn't do what was asked (OpenCode said no, or the plugin didn't answer): what was said. */
export class Unanswered extends Data.TaggedError("Unanswered")<{ readonly cause: string }> {}

/** One connected plugin instance, acting in its OpenCode. */
export interface Client {
	/** The session, or undefined when this OpenCode doesn't know it. */
	readonly session: (sessionID: SessionID) => Effect.Effect<SessionInfo | undefined, Unanswered>;
	readonly prompt: (prompt: Prompt) => Effect.Effect<void, Unanswered>;
}

/** An attached plugin instance, and the sessions in desk mode it last reported. */
interface Attached {
	readonly client: Client;
	readonly deskMode: ReadonlyArray<SessionID>;
}

export class OpenCode extends Context.Service<
	OpenCode,
	{
		/** Makes `client`'s sessions reachable until the scope closes. */
		readonly attach: (client: Client) => Effect.Effect<void, never, Scope.Scope>;
		/** How many clients are attached, now and after every change. */
		readonly attached: Stream.Stream<number>;
		/** How many clients are attached now. */
		readonly connected: Effect.Effect<number>;
		/** Each time a client attaches: it may know sessions (or moves) the others didn't. */
		readonly joined: Stream.Stream<void>;
		/** A client reports the sessions in desk mode in its OpenCode (all of them, each time). */
		readonly modes: (client: Client, sessions: ReadonlyArray<SessionID>) => Effect.Effect<void>;
		/** The sessions in desk mode across the attached clients (sorted), now and after every change. */
		readonly deskMode: Stream.Stream<ReadonlyArray<SessionID>>;
		readonly inDeskMode: Effect.Effect<ReadonlyArray<SessionID>>;
		/** The session, from the first attached client that knows it. */
		readonly session: (sessionID: SessionID) => Effect.Effect<Lookup>;
		/** Delivers through the attached client that knows the session: false when none does (nothing was sent). */
		readonly prompt: (prompt: Prompt) => Effect.Effect<boolean, DeliveryFailed>;
		/** A client reports that a session moved. */
		readonly move: (sessionID: SessionID) => Effect.Effect<void>;
		/** Sessions that moved, as they move. */
		readonly moved: Stream.Stream<SessionID>;
	}
>()("desk/OpenCode") {
	static get layer() {
		return Layer.effect(
			OpenCode,
			Effect.gen(function* () {
				/** The attached clients, in the order they came: the one state; the counts and desk-mode sessions follow from it. */
				const state = yield* SubscriptionRef.make<ReadonlyArray<Attached>>([]);
				const moved = yield* PubSub.unbounded<SessionID>();
				const joined = yield* PubSub.unbounded<void>();
				const count = (all: ReadonlyArray<Attached>) => all.length;
				// Instances of one OpenCode report the same sessions, so they're counted once.
				const inDeskMode = (all: ReadonlyArray<Attached>): ReadonlyArray<SessionID> =>
					[...new Set(all.flatMap((attached) => attached.deskMode))].sort();
				const sameSessions = (a: ReadonlyArray<SessionID>, b: ReadonlyArray<SessionID>) =>
					a.length === b.length && a.every((session, index) => session === b[index]);

				type Found = { readonly client: Client | undefined; readonly lookup: Lookup };
				/** Asks `clients` in turn; `unreachable`: one asked before couldn't answer. */
				const ask = (
					sessionID: SessionID,
					clients: ReadonlyArray<Attached>,
					unreachable: boolean,
				): Effect.Effect<Found> => {
					const [first, ...rest] = clients;
					if (first === undefined)
						return Effect.succeed({ client: undefined, lookup: unreachable ? Lookup.Unreachable() : Lookup.Unknown() });
					return first.client.session(sessionID).pipe(
						Effect.matchEffect({
							onFailure: () => ask(sessionID, rest, true),
							onSuccess: (session) =>
								session
									? Effect.succeed({ client: first.client, lookup: Lookup.Known({ session }) })
									: ask(sessionID, rest, unreachable),
						}),
					);
				};
				/** The first attached client that knows the session. One that can't answer is skipped, and remembered. */
				const find = (sessionID: SessionID) =>
					Effect.flatMap(SubscriptionRef.get(state), (all) => ask(sessionID, all, false));

				return OpenCode.of({
					attach: (client) =>
						Effect.acquireRelease(
							Effect.andThen(
								SubscriptionRef.update(state, (all) => [...all, { client, deskMode: [] }]),
								PubSub.publish(joined, undefined),
							),
							() => SubscriptionRef.update(state, (all) => all.filter((attached) => attached.client !== client)),
						),
					attached: Stream.changes(Stream.map(SubscriptionRef.changes(state), count)),
					connected: Effect.map(SubscriptionRef.get(state), count),
					joined: Stream.fromPubSub(joined),
					modes: (client, sessions) =>
						SubscriptionRef.update(state, (all) =>
							all.map((attached) => (attached.client === client ? { client, deskMode: sessions } : attached)),
						),
					deskMode: Stream.changesWith(Stream.map(SubscriptionRef.changes(state), inDeskMode), sameSessions),
					inDeskMode: Effect.map(SubscriptionRef.get(state), inDeskMode),
					session: (sessionID) => Effect.map(find(sessionID), (found) => found.lookup),
					prompt: (prompt) =>
						Effect.flatMap(find(prompt.sessionID), ({ client }) =>
							client
								? client.prompt(prompt).pipe(
										Effect.mapError(({ cause }) => new DeliveryFailed({ session: prompt.sessionID, cause })),
										Effect.as(true),
									)
								: Effect.succeed(false),
						),
					move: (sessionID) => Effect.asVoid(PubSub.publish(moved, sessionID)),
					moved: Stream.fromPubSub(moved),
				});
			}),
		);
	}
}
