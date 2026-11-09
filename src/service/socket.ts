/**
 * The service's Unix socket, where plugin instances connect: the `PluginApi` RPC group (`protocol.ts`) served there.
 * The registration (`registration.ts`) keeps the store to one service; the socket file it finds is a stale one (a
 * crashed service's), and goes.
 *
 * A plugin instance is attached for as long as its `attach` stream runs: a client (`Clients`) of the service, its
 * OpenCode reachable (`OpenCode`). The service's calls into that OpenCode go out on the stream; the plugin's `reply`
 * settles each, within `callTimeout`.
 */
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import type { ProjectID } from "@opencode/schema/project-id";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Stream from "effect/Stream";
import type { SessionID } from "../entry";
import { type Client, OpenCode, Unanswered } from "../opencode";
import { Projects } from "../projects";
import { build, type Outcome, Outdated, PluginApi, protocol, type ServiceCall } from "../protocol";
import { Api } from "./api";
import { Clients } from "./clients";

/** How long a call may wait for the plugin's answer. */
const callTimeout = "30 seconds";

/**
 * Whether this service is the outdated side: the contract on disk is no longer the one it loaded. The plugin always
 * starts the service from the code on disk, so then the service makes way; otherwise the plugin is behind.
 */
export const changedOnDisk = () => build() !== protocol;

/** One attached plugin instance: its OpenCode as a `Client`, and its calls waiting for a reply. */
interface Attached {
	readonly client: Client;
	/** Its calls that wait for the plugin's reply, by call id. */
	readonly waiting: Ref.Ref<ReadonlyMap<number, Deferred.Deferred<Outcome>>>;
}

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
	const rest = new Map(map);
	rest.delete(key);
	return rest;
};

const handlers = (outdated: () => boolean) =>
	PluginApi.toLayer(
		Effect.gen(function* () {
			const api = yield* Api;
			const opencode = yield* OpenCode;
			const projects = yield* Projects;
			const clients = yield* Clients;
			/** By RPC client id, while attached. */
			const attachments = yield* Ref.make<ReadonlyMap<number, Attached>>(new Map());
			const lastCall = yield* Ref.make(0);
			/** Work started by a request that outlives it; it ends with the service. */
			const background = yield* FiberSet.make();
			/** Looks the sessions up, so their projects are known and named (`Projects`). */
			const learn = (sessions: ReadonlyArray<SessionID>, directory: string) =>
				Effect.forEach(sessions, (session) => projects.of({ session, directory }), { discard: true });

			const attach = (
				id: number,
				project: { readonly id: ProjectID; readonly directory: string },
				sessions: ReadonlyArray<SessionID>,
			) =>
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
					yield* projects.remember(project.id, project.directory);
					// Where its sessions in desk mode are, and so their projects' names, even with nothing on the desk yet: a
					// session can belong to another project than the location (an older id of the same repository, say). In
					// the background: the lookups go out on the stream this returns.
					yield* Effect.forkScoped(learn(sessions, project.directory));
					yield* Effect.logInfo(
						`desk: a plugin attached in ${project.directory} (project ${project.id}), ${sessions.length} in desk mode`,
					);
					return Stream.fromQueue(calls);
				});

			return PluginApi.of({
				hello: ({ protocol: theirs }) =>
					Effect.gen(function* () {
						if (theirs === protocol) return { url: api.url };
						const outdatedHere = outdated();
						yield* Effect.logWarning(
							`desk: a plugin speaks build ${theirs}, this service ${protocol}; ${outdatedHere ? "this service is outdated: making way" : "the plugin is outdated: it's told to reload"}`,
						);
						// This service is the old side: make way for the one the plugin starts from the code on disk. The reply goes out first.
						if (outdatedHere) {
							// The sleep: so the `Outdated` reply is written to the socket before it closes.
							yield* FiberSet.run(background, Effect.andThen(Effect.sleep("100 millis"), clients.retire));
							return yield* new Outdated({ side: "service" });
						}
						return yield* new Outdated({ side: "plugin" });
					}),
				attach: ({ project, sessions }, { client }) => Stream.unwrap(attach(client.id, project, sessions)),
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
				adopt: api.adopt,
				answer: api.answer,
				resolve: api.resolve,
				prioritize: api.prioritize,
				list: api.list,
				page: api.page,
			});
		}),
	);

/**
 * Under Bun, a plugin hanging up cleanly reaches the socket server as a read error (ECONNRESET, EPIPE), which it logs as an
 * error. It isn't one: the attachment ends either way. Everything else is logged as usual.
 */
const hungUp = (cause: Cause.Cause<unknown>) => {
	const error = Cause.squash(cause) as
		| { _tag?: string; reason?: { _tag?: string; cause?: { code?: string } } }
		| undefined;
	return (
		error?._tag === "SocketError" &&
		error.reason?._tag === "SocketReadError" &&
		["ECONNRESET", "EPIPE"].includes(error.reason.cause?.code ?? "")
	);
};
const logger = Logger.layer(
	[Logger.make((options) => (hungUp(options.cause) ? undefined : Logger.defaultLogger.log(options)))],
	{ mergeWithExisting: false },
);

export const layer = (path: string, outdated: () => boolean = changedOnDisk) =>
	RpcServer.layer(PluginApi).pipe(
		Layer.provide(handlers(outdated)),
		Layer.provide(RpcServer.layerProtocolSocketServer),
		Layer.provide(BunSocketServer.layer({ path })),
		// The registration is ours, so a socket file here is a dead service's: it would keep us from listening.
		Layer.provide(Layer.effectDiscard(Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.ignore(fs.remove(path))))),
		Layer.provide(RpcSerialization.layerNdjson),
		Layer.provide(logger),
	);
