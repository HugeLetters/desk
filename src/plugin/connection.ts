/**
 * A plugin instance's connection to the desk service: an RPC client of `PluginApi` (`protocol.ts`) over the service's
 * socket. While it's wanted (a session here is in desk mode), it starts the service (detached, so it outlives this
 * OpenCode) when nobody answers, says `hello`, and holds `attach` open, answering the service's calls into this
 * OpenCode (`serve`) as they come on it. When the service goes, it does it all again, starting a new one; requests
 * wait for that.
 *
 * A machine (`machine.ts`): `Off`; `Connecting` and then `Live`, on one socket (one `run`, the `link`); `Backoff` a
 * moment after the link drops; `Refused` while this plugin is older than the service, until it's turned off.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { SessionID } from "../entry";
import * as Machine from "../machine";
import { type Outcome, PluginApi, type Prompt, protocol, type ServiceCall, type SessionInfo } from "../protocol";

/** The service can't be reached, or won't take this plugin (the message says why). */
export class DeskError extends Data.TaggedError("DeskError")<{ readonly message: string }> {}

export type Client = RpcClient.FromGroup<typeof PluginApi, RpcClientError>;

export interface Options {
	readonly socket: string;
	/** Starts the service; run when nothing answers on the socket. */
	readonly start: Effect.Effect<void>;
	/** This plugin instance's directory. */
	readonly directory: string;
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
	/** Wanted from the start (default: off until `want`). */
	readonly wanted?: boolean;
}

export interface Connection {
	/** Connects, or hangs up; done once the connection has taken it in. */
	readonly want: (on: boolean) => Effect.Effect<void>;
	/** The service's API, once connected; fails at once while off or refused. */
	readonly client: Effect.Effect<Client, DeskError>;
	/** The service's API if connected right now. */
	readonly live: Effect.Effect<Option.Option<Client>>;
	/** The page's URL, from the service's answer to `hello`. */
	readonly url: Effect.Effect<string, DeskError>;
}

export type State = Data.TaggedEnum<{
	// biome-ignore lint/complexity/noBannedTypes: a TaggedEnum member without fields is `{}`.
	Off: {};
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Connecting: {};
	Live: { readonly client: Client; readonly url: string };
	/** Why the link dropped. */
	Backoff: { readonly message: string };
	Refused: { readonly message: string };
}>;
export const State = Data.taggedEnum<State>();

export type Event = Data.TaggedEnum<{
	Want: { readonly on: boolean };
	/** The service answered `hello`. */
	Hello: { readonly client: Client; readonly url: string };
	/** The link ended: the service went, or couldn't be started or greeted. */
	Dropped: { readonly message: string };
	/** The service won't take this plugin: it's older. */
	Outdated: { readonly message: string };
	/** `Backoff` is over. */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Retry: {};
}>;
export const Event = Data.taggedEnum<Event>();

export const reconcile = (state: State, event: Event): State => {
	switch (event._tag) {
		case "Want":
			return !event.on ? State.Off() : state._tag === "Off" ? State.Connecting() : state;
		case "Hello":
			return state._tag === "Connecting" ? State.Live({ client: event.client, url: event.url }) : state;
		case "Dropped":
			return state._tag === "Connecting" || state._tag === "Live" ? State.Backoff({ message: event.message }) : state;
		case "Outdated":
			return state._tag === "Connecting" ? State.Refused({ message: event.message }) : state;
		case "Retry":
			return state._tag === "Backoff" ? State.Connecting() : state;
	}
};

/** `Connecting` and `Live` are one link: one socket, one `run`. */
export const key = (state: State) => (state._tag === "Live" ? "Connecting" : state._tag);

const off = "Desk mode is off in this directory; the user turns it on with /desk-mode.";

/** A failure's message, whatever was thrown. */
export const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: typeof error === "object" && error !== null && "message" in error
			? String(error.message)
			: String(error);

/** Whether a service answers on `path`: connects, and hangs up at once. */
export const answering = (path: string): Effect.Effect<boolean> =>
	BunSocket.makeNet({ path }).pipe(
		Effect.flatMap((socket) => socket.reader),
		Effect.scoped,
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

/** The connection, off until wanted; hangs up when the scope closes. */
export const make = (options: Options): Effect.Effect<Connection, never, Scope.Scope> =>
	Effect.gen(function* () {
		const transport = RpcClient.layerProtocolSocket().pipe(
			Layer.provide(BunSocket.layerNet({ path: options.socket })),
			Layer.provide(RpcSerialization.layerNdjson),
		);

		/** Answers one of the service's calls, in this OpenCode; a failure is the answer, not the connection's. */
		const answer = (client: Client, call: ServiceCall) =>
			(call._tag === "Session"
				? Effect.map(options.serve.session(call.sessionID), (session): Outcome => ({ _tag: "Session", session }))
				: Effect.as(options.serve.prompt(call.prompt), { _tag: "Prompted" } as Outcome)
			).pipe(
				Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Failed", cause: errorMessage(error) })),
				Effect.flatMap((outcome) => client.reply({ call: call.call, outcome })),
				Effect.ignore,
			);

		/** Nobody answers: start the service and wait until it does. */
		const ensure = Effect.gen(function* () {
			if (yield* answering(options.socket)) return;
			yield* options.start;
			yield* answering(options.socket).pipe(
				Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (up) => up }),
				Effect.timeoutOrElse({
					duration: options.timeout ?? "10 seconds",
					orElse: () =>
						Effect.fail(new DeskError({ message: `The desk service didn't start (socket ${options.socket}).` })),
				}),
			);
		});

		/** One link, for as long as it lasts: hello, then the attachment, answering the calls that come on it. */
		const link = (emit: (event: Event) => Effect.Effect<void>) =>
			Effect.gen(function* () {
				yield* ensure;
				const client = yield* RpcClient.make(PluginApi);
				const greeted = yield* client.hello({ protocol }).pipe(
					// Something that doesn't speak this protocol at all answers nothing: try again later rather than wait for good.
					Effect.timeoutOrElse({
						duration: "5 seconds",
						orElse: () =>
							Effect.fail(new DeskError({ message: `The desk service on ${options.socket} doesn't answer hello.` })),
					}),
					Effect.map(({ url }) => Option.some(url)),
					Effect.catchTag("Outdated", ({ side }) =>
						side === "plugin"
							? Effect.as(
									emit(
										Event.Outdated({
											message: "This OpenCode's desk plugin is older than the desk service: run /reload.",
										}),
									),
									Option.none<string>(),
								)
							: // It's making way for a new one: start that next time round.
								Effect.fail(
									new DeskError({
										message: "The desk service is older than this plugin; it's making way for a new one.",
									}),
								),
					),
				);
				if (Option.isNone(greeted)) return;
				yield* emit(Event.Hello({ client, url: greeted.value }));
				yield* client
					.attach({ directory: options.directory, sessions: yield* options.modes })
					.pipe(Stream.runForEach((call) => Effect.forkScoped(answer(client, call))));
				yield* emit(Event.Dropped({ message: "The desk service hung up." }));
			}).pipe(
				Effect.scoped,
				Effect.provide(transport),
				Effect.catchCause((cause) => emit(Event.Dropped({ message: errorMessage(Cause.squash(cause)) }))),
			);

		const actor = yield* Machine.start<State, Event, never>({
			initial: options.wanted ? State.Connecting() : State.Off(),
			reconcile,
			key,
			run: (state, emit) =>
				state._tag === "Connecting"
					? link(emit)
					: state._tag === "Backoff"
						? Effect.andThen(Effect.sleep("250 millis"), emit(Event.Retry()))
						: Effect.void,
		});

		/** What a request gets: the link once it's live, or why there's none; nothing yet while it's on its way. */
		const settled = actor.when(
			(state): Option.Option<Effect.Effect<{ readonly client: Client; readonly url: string }, DeskError>> =>
				state._tag === "Live"
					? Option.some(Effect.succeed(state))
					: state._tag === "Off" || state._tag === "Refused"
						? Option.some(Effect.fail(new DeskError({ message: state._tag === "Off" ? off : state.message })))
						: Option.none(),
		);
		const live = Effect.flatten(settled);
		const connection: Connection = {
			want: (on) =>
				Effect.andThen(
					actor.send(Event.Want({ on })),
					actor.when((state) => ((state._tag === "Off") === !on ? Option.some(undefined) : Option.none())),
				),
			client: Effect.map(live, (now) => now.client),
			live: Effect.map(actor.state, (state) => (state._tag === "Live" ? Option.some(state.client) : Option.none())),
			url: Effect.map(live, (now) => now.url),
		};
		return connection;
	});

/**
 * Starts `bun src/service/main.ts` detached, logging to `<store>/service.log`, which it gets as its own stdout and
 * stderr. With `node:child_process`, not Effect's `ChildProcess`: that one can detach and unref a child, but its output
 * goes to a pipe (or a sink) in this process, which breaks when this OpenCode exits, and the service outlives it. Nor
 * does Effect's `FileSystem` hand out the file descriptor `spawn` needs. The log is closed here once the child has it.
 */
export const startService = (env: { DESK_HOME: string; DESK_PORT: string }) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			mkdirSync(env.DESK_HOME, { recursive: true });
			return openSync(join(env.DESK_HOME, "service.log"), "a");
		}),
		(log) =>
			Effect.sync(() => {
				const main = join(dirname(import.meta.dir), "service", "main.ts");
				// Inside OpenCode, `process.execPath` is OpenCode's own binary, which runs as Bun with BUN_BE_BUN.
				const bun = Bun.which("bun");
				spawn(bun ?? process.execPath, [main], {
					detached: true,
					stdio: ["ignore", log, log],
					env: { ...process.env, ...env, ...(bun ? {} : { BUN_BE_BUN: "1" }) },
				}).unref();
			}),
		(log) => Effect.sync(() => closeSync(log)),
	);
