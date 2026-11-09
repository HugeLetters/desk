/**
 * A plugin instance's connection to the desk service: an RPC client of `PluginApi` (`protocol.ts`) over the service's
 * socket. It starts the service (detached, so it outlives this OpenCode) when nobody answers, says `hello`, and holds
 * `attach` open while the plugin is loaded, answering the service's calls into this OpenCode (`serve`) as they come
 * on it. When the service goes, it does it all again, starting a new one; requests wait for that.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectID } from "@opencode/schema/project-id";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type { SessionID } from "../entry";
import { type Outcome, PluginApi, type Prompt, protocol, type ServiceCall, type SessionInfo } from "../protocol";

/** The service can't be reached, or won't take this plugin (the message says why). */
export class DeskError extends Data.TaggedError("DeskError")<{ readonly message: string }> {}

export type Client = RpcClient.FromGroup<typeof PluginApi, RpcClientError>;

export interface Options {
	readonly socket: string;
	/** Starts the service; run when nothing answers on the socket. */
	readonly start: Effect.Effect<void>;
	/** This plugin instance's location's project. */
	readonly project: { readonly id: ProjectID; readonly directory: string };
	/** The sessions in desk mode, reported on every attach (the service holds them only while attached). */
	readonly modes: Effect.Effect<ReadonlyArray<SessionID>>;
	/** Answers the service's calls, in this OpenCode. */
	readonly serve: {
		/** Null when this OpenCode doesn't know the session. */
		readonly session: (sessionID: SessionID) => Effect.Effect<SessionInfo | null, unknown>;
		readonly prompt: (prompt: Prompt) => Effect.Effect<void, unknown>;
	};
	/** How long to wait for a started service to answer. */
	readonly timeout?: Duration.Input;
}

export interface Connection {
	/** The service's API, once connected. */
	readonly client: Effect.Effect<Client, DeskError>;
	/** The page's URL, from the service's answer to `hello`. */
	readonly url: Effect.Effect<string, DeskError>;
}

type State = { readonly _tag: "Connecting" } | { readonly _tag: "Live"; readonly client: Client; readonly url: string } | { readonly _tag: "Refused"; readonly message: string };

/** A failure's message, whatever was thrown. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));

/** Whether a service answers on `path`. */
export const answering = (path: string) =>
	Bun.connect({ unix: path, socket: { data() {} } }).then(
		(socket) => {
			socket.end();
			return true;
		},
		() => false,
	);

/** Connects for as long as the scope is open. */
export const make = (options: Options): Effect.Effect<Connection, never, Scope.Scope> =>
	Effect.gen(function* () {
		const state = yield* SubscriptionRef.make<State>({ _tag: "Connecting" });
		const transport = RpcClient.layerProtocolSocket().pipe(Layer.provide(BunSocket.layerNet({ path: options.socket })), Layer.provide(RpcSerialization.layerNdjson));

		/** Answers one of the service's calls, in this OpenCode; a failure is the answer, not the connection's. */
		const answer = (client: Client, call: ServiceCall) =>
			(call._tag === "Session" ? Effect.map(options.serve.session(call.sessionID), (session): Outcome => ({ _tag: "Session", session })) : Effect.as(options.serve.prompt(call.prompt), { _tag: "Prompted" } as Outcome)).pipe(
				Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Failed", cause: errorMessage(error) })),
				Effect.flatMap((outcome) => client.reply({ call: call.call, outcome })),
				Effect.ignore,
			);

		/** Nobody answers: start the service and wait until it does. */
		const ensure = Effect.gen(function* () {
			if (yield* Effect.promise(() => answering(options.socket))) return;
			yield* options.start;
			yield* Effect.promise(() => answering(options.socket)).pipe(
				Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (up) => up }),
				Effect.timeoutOrElse({
					duration: options.timeout ?? "10 seconds",
					orElse: () => Effect.fail(new DeskError({ message: `The desk service didn't start (socket ${options.socket}).` })),
				}),
			);
		});

		/** One connection, for as long as it lasts: hello, then the attachment, answering the calls that come on it. */
		const connection = Effect.gen(function* () {
			yield* ensure;
			const client = yield* RpcClient.make(PluginApi);
			const { url } = yield* client.hello({ protocol }).pipe(
				// Something that doesn't speak this protocol at all answers nothing: try again later rather than wait for good.
				Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new DeskError({ message: `The desk service on ${options.socket} doesn't answer hello.` })) }),
				Effect.catchTag("Outdated", ({ side }) =>
					side === "plugin"
						? Effect.andThen(SubscriptionRef.set(state, { _tag: "Refused", message: "This OpenCode's desk plugin is older than the desk service: run /reload." }), Effect.never)
						: // It's making way for a new one: start that next time round.
							Effect.fail(new DeskError({ message: "The desk service is older than this plugin; it's making way for a new one." })),
				),
			);
			yield* SubscriptionRef.set(state, { _tag: "Live", client, url });
			yield* client.attach({ project: options.project, sessions: yield* options.modes }).pipe(Stream.runForEach((call) => Effect.forkScoped(answer(client, call))));
		}).pipe(Effect.scoped, Effect.provide(transport));

		yield* connection.pipe(
			Effect.exit,
			Effect.andThen(SubscriptionRef.update(state, (now): State => (now._tag === "Refused" ? now : { _tag: "Connecting" }))),
			Effect.andThen(Effect.sleep("250 millis")),
			Effect.forever,
			Effect.forkScoped,
		);

		const live = SubscriptionRef.changes(state).pipe(
			Stream.filter((now) => now._tag !== "Connecting"),
			Stream.runHead,
			Effect.map(Option.getOrThrow),
			Effect.flatMap((now) => (now._tag === "Live" ? Effect.succeed(now) : Effect.fail(new DeskError({ message: now._tag === "Refused" ? now.message : "The desk service is gone." })))),
		);
		return {
			client: Effect.map(live, (now) => now.client),
			url: Effect.map(live, (now) => now.url),
		} satisfies Connection;
	});

/**
 * Starts `bun src/service/main.ts` detached, logging to `<store>/service.log`. With `node:child_process`, not Effect's
 * `ChildProcess`: that one ends the child with its scope, and the service has to outlive this OpenCode.
 */
export const startService = (env: { DESK_HOME: string; DESK_PORT: string }) =>
	Effect.sync(() => {
		mkdirSync(env.DESK_HOME, { recursive: true });
		const log = openSync(join(env.DESK_HOME, "service.log"), "a");
		const main = join(dirname(import.meta.dir), "service", "main.ts");
		// Inside OpenCode, `process.execPath` is OpenCode's own binary, which runs as Bun with BUN_BE_BUN.
		const bun = Bun.which("bun");
		const child = spawn(bun ?? process.execPath, [main], {
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env, ...env, ...(bun ? {} : { BUN_BE_BUN: "1" }) },
		});
		child.unref();
	});
