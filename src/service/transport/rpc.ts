/**
 * The desk's API (`api.ts`) served over a WebSocket at `/rpc`, on the page's server (`http.ts`): the page and the
 * plugin instances connect there alike, one connection each. What each request does is `Api`'s; here is what's about
 * the connection: the version check on `hello`, and the bridge into a plugin's OpenCode.
 *
 * A plugin instance is attached for as long as its `attach` stream runs: a client (`Clients`) of the service, its
 * OpenCode reachable (`OpenCode`). The service's calls into that OpenCode go out on the stream; the plugin's `reply`
 * settles each, within `callTimeout`. An open page is a client for as long as its `view` stream runs.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Stream from "effect/Stream";
import { DeskApi, type Outcome, Outdated, type ServiceCall } from "../../api/api";
import { build, protocol } from "../../api/protocol";
import { rpcPath } from "../../api/routes";
import type { SessionID } from "../../model/entry";
import { Clients } from "../clients";
import { type Client, OpenCode, Unanswered } from "../opencode/opencode";
import { Sessions } from "../opencode/sessions";
import { Api } from "./api";

/** How long a call may wait for the plugin's answer. */
const callTimeout = "30 seconds";

/** Whether this service is outdated, given the contract's version on disk now (`build`). */
export const outdatedBy = <R>(onDisk: Effect.Effect<string, PlatformError.PlatformError, R>) =>
	onDisk.pipe(
		Effect.map((now) => now !== protocol),
		Effect.catch((error) =>
			// Gone: the code it loaded moved or was deleted, so whatever's on disk now is newer. Unreadable otherwise (a
			// checkout halfway through, say): no reason to make way.
			Effect.succeed(error.reason._tag === "NotFound"),
		),
	);

/**
 * Whether this service is the outdated side: the contract on disk is no longer the one it loaded. The plugin always
 * starts the service from the code on disk, so then the service makes way; otherwise the plugin is behind.
 */
export const changedOnDisk = outdatedBy(build);

/** One attached plugin instance: its OpenCode as a `Client`, and its calls waiting for a reply. */
interface Attached {
	readonly client: Client;
	/** Its calls that wait for the plugin's reply, by call id. */
	readonly waiting: Ref.Ref<ReadonlyMap<number, Deferred.Deferred<Outcome>>>;
}

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> =>
	new Map([...map].filter(([other]) => other !== key));

const handlers = (outdated: Effect.Effect<boolean, never, FileSystem.FileSystem>) =>
	DeskApi.toLayer(
		Effect.gen(function* () {
			const api = yield* Api;
			const opencode = yield* OpenCode;
			const sessions = yield* Sessions;
			const clients = yield* Clients;
			/** By RPC client id, while attached. */
			const attachments = yield* Ref.make<ReadonlyMap<number, Attached>>(new Map());
			const lastCall = yield* Ref.make(0);
			/** Work started by a request that outlives it; it ends with the service. */
			const background = yield* FiberSet.make();
			/** Looks the sessions up, so their desks are named (`Sessions`). */
			const learn = (inDeskMode: ReadonlyArray<SessionID>, directory: string) =>
				Effect.forEach(inDeskMode, (session) => sessions.name(session, directory), { discard: true });

			const attach = (id: number, directory: string, sessions: ReadonlyArray<SessionID>) =>
				Effect.gen(function* () {
					const calls = yield* Queue.unbounded<ServiceCall>();
					const waiting = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<Outcome>>>(new Map());
					/** Sends a call on the stream and waits for its reply. */
					const call = (make: (call: number) => ServiceCall) =>
						Effect.gen(function* () {
							const call = yield* Ref.updateAndGet(lastCall, (last) => last + 1);
							const reply = yield* Deferred.make<Outcome>();
							yield* Ref.update(waiting, (all) => new Map(all).set(call, reply));
							yield* Queue.offer(calls, make(call));
							return yield* Deferred.await(reply).pipe(
								Effect.timeoutOrElse({
									duration: callTimeout,
									orElse: () => Effect.fail(new Unanswered({ cause: "the plugin didn't answer in time" })),
								}),
								Effect.ensuring(Ref.update(waiting, (all) => without(all, call))),
							);
						});
					const failed = (outcome: Outcome) =>
						outcome._tag === "Failed" ? Effect.fail(new Unanswered({ cause: outcome.cause })) : Effect.succeed(outcome);
					const client: Client = {
						session: (sessionID) =>
							Effect.flatMap(
								call((call) => ({ _tag: "Session", call, sessionID })),
								failed,
							).pipe(
								Effect.map((outcome) => (outcome._tag === "Session" ? (outcome.session ?? undefined) : undefined)),
							),
						prompt: (prompt) =>
							Effect.asVoid(
								Effect.flatMap(
									call((call) => ({ _tag: "Prompt", call, prompt })),
									failed,
								),
							),
					};
					// All of it for as long as the stream runs: the plugin hanging up (or dying) ends it.
					yield* clients.hold;
					yield* Effect.acquireRelease(
						Ref.update(attachments, (all) => new Map(all).set(id, { client, waiting })),
						() =>
							Effect.andThen(
								Ref.update(attachments, (all) => without(all, id)),
								Effect.flatMap(Ref.get(waiting), (left) =>
									Effect.forEach(left.values(), (reply) =>
										Deferred.succeed(reply, { _tag: "Failed", cause: "the plugin went away" }),
									),
								),
							),
					);
					yield* opencode.attach(client);
					yield* opencode.modes(client, sessions);
					// Its sessions in desk mode, so their desks are named even with nothing on them yet. In the background: the
					// lookups go out on the stream this returns.
					yield* Effect.forkScoped(learn(sessions, directory));
					yield* Effect.logInfo(`desk: a plugin attached in ${directory}, ${sessions.length} in desk mode`);
					return Stream.fromQueue(calls);
				});

			return DeskApi.of({
				hello: ({ protocol: theirs }) =>
					Effect.gen(function* () {
						if (theirs === protocol) return { url: api.url };
						const outdatedHere = yield* outdated;
						yield* Effect.logWarning(
							`desk: a plugin speaks build ${theirs}, this service ${protocol}; ${outdatedHere ? "this service is outdated: making way" : "the plugin is outdated: it's told to reload"}`,
						);
						// This service is the old side: make way for the one the plugin starts from the code on disk. The reply goes out first.
						if (outdatedHere) {
							// The sleep: so the `Outdated` reply is written to the connection before it closes.
							yield* FiberSet.run(background, Effect.andThen(Effect.sleep("100 millis"), clients.retire));
							return yield* new Outdated({ side: "service" });
						}
						return yield* new Outdated({ side: "plugin" });
					}),
				attach: ({ directory, sessions }, { client }) => Stream.unwrap(attach(client.id, directory, sessions)),
				reply: ({ call, outcome }, { client }) =>
					Effect.gen(function* () {
						const attached = (yield* Ref.get(attachments)).get(client.id);
						const reply = attached && (yield* Ref.get(attached.waiting)).get(call);
						if (reply) yield* Deferred.succeed(reply, outcome);
					}),
				modes: ({ sessions }, { client }) =>
					Effect.gen(function* () {
						const attached = (yield* Ref.get(attachments)).get(client.id);
						if (!attached) return;
						yield* opencode.modes(attached.client, sessions);
						// In the background, as on attach: the lookups go out on the attachment's stream.
						yield* FiberSet.run(background, learn(sessions, ""));
					}),
				moved: ({ session }) => opencode.move(session),
				ask: api.ask,
				answer: api.answer,
				resolve: api.resolve,
				adopt: api.adopt,
				prioritize: api.prioritize,
				claim: api.claim,
				list: api.list,
				page: api.page,
				view: ({ session }) => Stream.unwrap(Effect.as(clients.hold, api.view(session))),
				submit: api.submit,
				send: api.send,
				discard: api.discard,
			});
		}),
	);

/** Registers `/rpc` on the page's `HttpRouter`; a WebSocket upgrade there is one client's connection. */
export const layer = (outdated: Effect.Effect<boolean, never, FileSystem.FileSystem> = changedOnDisk) =>
	RpcServer.layerHttp({ group: DeskApi, path: rpcPath, protocol: "websocket" }).pipe(
		Layer.provide(handlers(outdated)),
		Layer.provide(RpcSerialization.layerNdjson),
	);
