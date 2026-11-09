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
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { ProjectID } from "@opencode/schema/project-id";
import type { SessionID } from "../entry";
import { type Client, OpenCode, Unanswered } from "../opencode";
import { Projects } from "../projects";
import { build, type Outcome, Outdated, PluginApi, protocol, type ServiceCall } from "../protocol";
import { Api } from "./api";
import { Clients } from "./clients";

/** How long a call may wait for the plugin's answer. */
const callTimeout = "30 seconds";

/**
 * Whether this service is the outdated side: the code on disk is no longer the code it loaded. The plugin always starts
 * the service from the code on disk, so then the service makes way; otherwise the plugin is behind.
 */
export const changedOnDisk = () => build() !== protocol;

/** One attached plugin instance: its OpenCode as a `Client`, and its calls waiting for a reply. */
interface Attached {
	readonly client: Client;
	readonly waiting: Map<number, Deferred.Deferred<Outcome>>;
}

const handlers = (outdated: () => boolean) =>
	PluginApi.toLayer(
		Effect.gen(function* () {
			const api = yield* Api;
			const opencode = yield* OpenCode;
			const projects = yield* Projects;
			const clients = yield* Clients;
			/** By RPC client id, while attached. */
			const attachments = new Map<number, Attached>();
			let lastCall = 0;

			const attach = (id: number, project: { readonly id: ProjectID; readonly directory: string }, sessions: ReadonlyArray<SessionID>) =>
				Effect.gen(function* () {
					const calls = yield* Queue.unbounded<ServiceCall>();
					const waiting = new Map<number, Deferred.Deferred<Outcome>>();
					/** Sends a call on the stream and waits for its reply. */
					const call = (make: (call: number) => ServiceCall) =>
						Effect.gen(function* () {
							const call = ++lastCall;
							const reply = yield* Deferred.make<Outcome>();
							waiting.set(call, reply);
							yield* Queue.offer(calls, make(call));
							return yield* Deferred.await(reply).pipe(
								Effect.timeoutOrElse({ duration: callTimeout, orElse: () => Effect.fail(new Unanswered({ cause: "the plugin didn't answer in time" })) }),
								Effect.ensuring(Effect.sync(() => waiting.delete(call))),
							);
						});
					const failed = (outcome: Outcome) => (outcome._tag === "Failed" ? Effect.fail(new Unanswered({ cause: outcome.cause })) : Effect.succeed(outcome));
					const client: Client = {
						session: (sessionID) =>
							Effect.flatMap(call((call) => ({ _tag: "Session", call, sessionID })), failed).pipe(Effect.map((outcome) => (outcome._tag === "Session" ? (outcome.session ?? undefined) : undefined))),
						prompt: (prompt) => Effect.asVoid(Effect.flatMap(call((call) => ({ _tag: "Prompt", call, prompt })), failed)),
					};
					// All of it for as long as the stream runs: the plugin hanging up (or dying) ends it.
					yield* clients.hold;
					yield* Effect.acquireRelease(
						Effect.sync(() => attachments.set(id, { client, waiting })),
						() =>
							Effect.gen(function* () {
								attachments.delete(id);
								for (const reply of waiting.values()) yield* Deferred.succeed(reply, { _tag: "Failed", cause: "the plugin went away" });
							}),
					);
					yield* opencode.attach(client);
					yield* opencode.modes(client, sessions);
					yield* projects.remember(project.id, project.directory);
					yield* Effect.logInfo(`desk: a plugin attached in ${project.directory} (project ${project.id}), ${sessions.length} in desk mode`);
					return Stream.fromQueue(calls);
				});

			return PluginApi.of({
				hello: ({ protocol: theirs }) =>
					Effect.gen(function* () {
						if (theirs === protocol) return { url: api.url };
						const outdatedHere = outdated();
						yield* Effect.logWarning(`desk: a plugin speaks build ${theirs}, this service ${protocol}; ${outdatedHere ? "this service is outdated: making way" : "the plugin is outdated: it's told to reload"}`);
						// This service is the old side: make way for the one the plugin starts from the code on disk. The reply goes out first.
						if (outdatedHere) {
							yield* Effect.forkDetach(Effect.andThen(Effect.sleep("100 millis"), clients.retire));
							return yield* new Outdated({ side: "service" });
						}
						return yield* new Outdated({ side: "plugin" });
					}),
				attach: ({ project, sessions }, { client }) => Stream.unwrap(attach(client.id, project, sessions)),
				reply: ({ call, outcome }, { client }) =>
					Effect.suspend(() => {
						const reply = attachments.get(client.id)?.waiting.get(call);
						return reply ? Deferred.succeed(reply, outcome) : Effect.void;
					}).pipe(Effect.asVoid),
				modes: ({ sessions }, { client }) => {
					const attached = attachments.get(client.id);
					return attached ? opencode.modes(attached.client, sessions) : Effect.void;
				},
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
	const error = Cause.squash(cause) as { _tag?: string; reason?: { _tag?: string; cause?: { code?: string } } } | undefined;
	return error?._tag === "SocketError" && error.reason?._tag === "SocketReadError" && ["ECONNRESET", "EPIPE"].includes(error.reason.cause?.code ?? "");
};
const logger = Logger.layer([Logger.make((options) => (hungUp(options.cause) ? undefined : Logger.defaultLogger.log(options)))], { mergeWithExisting: false });

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
