/**
 * OpenCode, as far as the service needs it: the OpenCode servers whose plugin instances are connected right now, the
 * sessions they know, a way to prompt one, and the sessions that move to another project.
 *
 * Each plugin instance tells the service its server's endpoint when it connects and holds it (`attach`) while it
 * stays; a session is reachable while some attached server knows it. `Client` is the seam to one server:
 * `OpenCode.client` talks to it with `@opencode/client`, tests pass a fake.
 */
import { OpenCode as Sdk } from "@opencode/client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { DeskError } from "./errors";

/** Where an OpenCode server listens, and its password when it has one (user `opencode`). */
export interface Endpoint {
	readonly url: string;
	readonly password?: string | undefined;
}

export interface SessionInfo {
	readonly id: string;
	readonly parentID?: string | undefined;
	readonly projectID: string;
	readonly directory: string;
}

export interface Prompt {
	readonly sessionID: string;
	/** The message id: a server admits each id once, so a retry can't deliver twice. */
	readonly id: string;
	readonly text: string;
	readonly delivery: "queue" | "steer";
	readonly files: ReadonlyArray<{ readonly uri: string; readonly name: string }>;
}

/** One OpenCode server. */
export interface Client {
	/** The session, or undefined when this server doesn't know it. Rejects when the server can't be reached. */
	readonly session: (sessionID: string) => Promise<SessionInfo | undefined>;
	readonly prompt: (prompt: Prompt) => Promise<void>;
	/** The ids of sessions moved to another directory (perhaps another project), until `signal` aborts. */
	readonly moves: (signal: AbortSignal) => AsyncIterable<string>;
}

export type Connect = (endpoint: Endpoint) => Client;

export class OpenCode extends Context.Service<
	OpenCode,
	{
		/** Makes `endpoint`'s sessions reachable until the scope closes (several holders may share one endpoint). */
		readonly attach: (endpoint: Endpoint) => Effect.Effect<void, never, Scope.Scope>;
		/** The attached endpoints' URLs, now and after every change. */
		readonly attached: Stream.Stream<ReadonlyArray<string>>;
		/** The session, from the first attached server that knows it; undefined when none does. */
		readonly session: (sessionID: string) => Effect.Effect<SessionInfo | undefined>;
		/** Delivers to the attached server that knows the session: false when none does (nothing was sent). */
		readonly prompt: (prompt: Prompt) => Effect.Effect<boolean, DeskError>;
		/** Sessions that moved, as they move. */
		readonly moved: Stream.Stream<string>;
	}
>()("desk/OpenCode") {
	static layer(connect: Connect) {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const servers = new Map<string, { client: Client; holders: number; stop: AbortController }>();
				const attached = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
				const moved = yield* PubSub.unbounded<string>();
				const services = yield* Effect.context<never>();
				const publish = (url: string) => SubscriptionRef.set(attached, [...servers.keys()]).pipe(Effect.as(url));

				const watch = (client: Client, stop: AbortController) =>
					Effect.promise(async () => {
						try {
							for await (const sessionID of client.moves(stop.signal)) Effect.runForkWith(services)(PubSub.publish(moved, sessionID));
						} catch {
							// The server went away; its plugin instances reconnect and attach again.
						}
					});

				/** Attached clients, in the order they came. */
				const clients = () => [...servers.values()].map((server) => server.client);
				const find = (sessionID: string) =>
					Effect.promise(async () => {
						for (const client of clients()) {
							const session = await client.session(sessionID).catch(() => undefined);
							if (session) return { client, session };
						}
						return undefined;
					});

				return OpenCode.of({
					attach: (endpoint) =>
						Effect.acquireRelease(
							Effect.suspend(() => {
								const server = servers.get(endpoint.url);
								if (server) {
									server.holders++;
									return Effect.void;
								}
								const stop = new AbortController();
								const client = connect(endpoint);
								servers.set(endpoint.url, { client, holders: 1, stop });
								return Effect.andThen(Effect.forkDetach(watch(client, stop)), publish(endpoint.url));
							}),
							() =>
								Effect.suspend(() => {
									const server = servers.get(endpoint.url);
									if (!server || --server.holders > 0) return Effect.void;
									server.stop.abort();
									servers.delete(endpoint.url);
									return publish(endpoint.url);
								}),
						).pipe(Effect.asVoid),
					attached: SubscriptionRef.changes(attached),
					session: (sessionID) => Effect.map(find(sessionID), (found) => found?.session),
					prompt: (prompt) =>
						Effect.flatMap(find(prompt.sessionID), (found) =>
							found
								? Effect.tryPromise({ try: () => found.client.prompt(prompt), catch: (cause) => new DeskError({ message: `Delivering to ${prompt.sessionID}: ${String(cause)}` }) }).pipe(Effect.as(true))
								: Effect.succeed(false),
						),
					moved: Stream.fromPubSub(moved),
				});
			}),
		);
	}

	/** A real OpenCode server, through `@opencode/client`. */
	static readonly client: Connect = (endpoint) => {
		const headers: Record<string, string> = endpoint.password ? { authorization: `Basic ${btoa(`opencode:${endpoint.password}`)}` } : {};
		const sdk = Sdk.make({ baseUrl: endpoint.url, headers });
		return {
			session: async (sessionID) => {
				try {
					const info = await sdk.session.get({ sessionID });
					return { id: info.id, parentID: info.parentID, projectID: info.projectID, directory: info.location.directory };
				} catch (error) {
					// A 404 means "not this server's session"; anything else (refused, 500) is the server being down.
					if (/not ?found|404/i.test(String((error as { message?: string })?.message ?? error))) return undefined;
					throw error;
				}
			},
			prompt: async ({ sessionID, id, text, delivery, files }) => {
				await sdk.session.prompt({ sessionID, id, text, delivery, files: files.map((file) => ({ uri: file.uri, name: file.name })) });
			},
			moves: async function* (signal) {
				for await (const event of sdk.event.subscribe({ types: ["session.moved"], signal })) {
					if (event.type === "session.moved") yield event.data.sessionID;
				}
			},
		};
	};
}
