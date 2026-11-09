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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { DeskError } from "./errors";
import type { Prompt, SessionInfo } from "./protocol";

export type { Prompt, SessionInfo };

/** One connected plugin instance, acting in its OpenCode. */
export interface Client {
	/** The session, or undefined when this OpenCode doesn't know it. Rejects when the plugin can't answer. */
	readonly session: (sessionID: string) => Promise<SessionInfo | undefined>;
	readonly prompt: (prompt: Prompt) => Promise<void>;
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
		/** A client reports the sessions in desk mode in its OpenCode (all of them, each time). */
		readonly modes: (client: Client, sessions: ReadonlyArray<string>) => Effect.Effect<void>;
		/** How many sessions are in desk mode across the attached clients, now and after every change. */
		readonly deskMode: Stream.Stream<number>;
		readonly inDeskMode: Effect.Effect<number>;
		/** The session, from the first attached client that knows it; undefined when none does. */
		readonly session: (sessionID: string) => Effect.Effect<SessionInfo | undefined>;
		/** Delivers through the attached client that knows the session: false when none does (nothing was sent). */
		readonly prompt: (prompt: Prompt) => Effect.Effect<boolean, DeskError>;
		/** A client reports that a session moved. */
		readonly move: (sessionID: string) => Effect.Effect<void>;
		/** Sessions that moved, as they move. */
		readonly moved: Stream.Stream<string>;
	}
>()("desk/OpenCode") {
	static get layer() {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				/** Attached clients, in the order they came. */
				const clients: Array<Client> = [];
				const attached = yield* SubscriptionRef.make(0);
				const moved = yield* PubSub.unbounded<string>();
				/** Each client's sessions in desk mode; instances of one OpenCode report the same ones, so they're counted once. */
				const modes = new Map<Client, ReadonlyArray<string>>();
				const deskMode = yield* SubscriptionRef.make(0);
				const publish = Effect.suspend(() =>
					Effect.andThen(SubscriptionRef.set(attached, clients.length), SubscriptionRef.set(deskMode, new Set([...modes.values()].flat()).size)),
				);

				const find = (sessionID: string) =>
					Effect.promise(async () => {
						for (const client of [...clients]) {
							const session = await client.session(sessionID).catch(() => undefined);
							if (session) return { client, session };
						}
						return undefined;
					});

				return OpenCode.of({
					attach: (client) =>
						Effect.acquireRelease(
							Effect.suspend(() => {
								clients.push(client);
								return publish;
							}),
							() =>
								Effect.suspend(() => {
									clients.splice(clients.indexOf(client), 1);
									modes.delete(client);
									return publish;
								}),
						),
					attached: SubscriptionRef.changes(attached),
					modes: (client, sessions) =>
						Effect.suspend(() => {
							if (!clients.includes(client)) return Effect.void;
							modes.set(client, sessions);
							return publish;
						}),
					deskMode: SubscriptionRef.changes(deskMode),
					inDeskMode: SubscriptionRef.get(deskMode),
					connected: SubscriptionRef.get(attached),
					session: (sessionID) => Effect.map(find(sessionID), (found) => found?.session),
					prompt: (prompt) =>
						Effect.flatMap(find(prompt.sessionID), (found) =>
							found
								? Effect.tryPromise({ try: () => found.client.prompt(prompt), catch: (cause) => new DeskError({ message: `Delivering to ${prompt.sessionID}: ${String(cause)}` }) }).pipe(Effect.as(true))
								: Effect.succeed(false),
						),
					move: (sessionID) => Effect.asVoid(PubSub.publish(moved, sessionID)),
					moved: Stream.fromPubSub(moved),
				});
			}),
		);
	}
}
