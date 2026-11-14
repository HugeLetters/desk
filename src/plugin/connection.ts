/**
 * A plugin instance's connection to the desk service: an RPC client of `DeskApi` (`api.ts`) over a WebSocket to the
 * service's port (`ws://127.0.0.1:<port>/rpc`), the port setting's. While it's wanted (a session here is in desk
 * mode), it starts the service (detached, so it outlives this OpenCode) when nothing listens there, says `hello`, and
 * holds `attach` open, answering the service's calls into this OpenCode (`serve`) as they come on it. When the service
 * goes, it does it all again, starting a new one; requests wait for that.
 *
 * Something else may have the port: then the WebSocket's upgrade fails while the port still takes connections, and the
 * agents are told so (`taken`), rather than waiting for a service that can't start there.
 *
 * A machine (`machine.ts`): `Off`; `Connecting` and then `Live`, on one WebSocket (one `run`, the `link`); `Backoff` a
 * moment after the link drops; `Refused` while this plugin is older than the service or another program has the port,
 * until it's turned off.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { DeskApi, type Outcome, type Prompt, type ServiceCall, type SessionInfo } from "../api/api";
import { protocol } from "../api/protocol";
import { rpcPath } from "../api/routes";
import type { SessionID } from "../model/entry";
import type { Empty } from "../shared/empty";
import * as Machine from "../shared/machine";

/** The service can't be reached, or won't take this plugin (the message says why). */
export class DeskError extends Data.TaggedError("DeskError")<{ readonly message: string }> {}

export type Client = RpcClient.FromGroup<typeof DeskApi, RpcClientError.RpcClientError>;

/** `R`: what starting the service needs. */
export interface Options<R = never> {
	/** The service's port, on 127.0.0.1. */
	readonly port: number;
	/** Starts the service; run when nothing listens on the port. */
	readonly start: Effect.Effect<void, unknown, R>;
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

/** A live link: the service's API, and its page's URL from its answer to `hello`. */
export interface Link {
	readonly client: Client;
	readonly url: string;
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
	/** The live link now (none while not connected), then each new one, and none whenever it drops. */
	readonly links: Stream.Stream<Option.Option<Link>>;
}

/** The same link, or none both times. */
const sameLink = (a: Option.Option<Link>, b: Option.Option<Link>) =>
	Option.isNone(a) ? Option.isNone(b) : Option.isSome(b) && a.value.client === b.value.client;

export type State = Data.TaggedEnum<{
	Off: Empty;
	Connecting: Empty;
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
	/** Another program has the port. */
	Taken: { readonly message: string };
	/** `Backoff` is over. */
	Retry: Empty;
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
		case "Taken":
			return state._tag === "Connecting" ? State.Refused({ message: event.message }) : state;
		case "Retry":
			return state._tag === "Backoff" ? State.Connecting() : state;
	}
};

/** `Connecting` and `Live` are one link: one WebSocket, one `run`. */
export const key = (state: State) => (state._tag === "Live" ? "Connecting" : state._tag);

const off = "Desk mode is off in this directory; the user turns it on with /desk-mode.";

/** A failure's message, whatever was thrown. */
export const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: Predicate.isObject(error) && Predicate.hasProperty(error, "message")
			? String(error.message)
			: String(error);

/** What the agents are told while another program has `port`. */
export const taken = (port: number) =>
	`Port ${port} is taken by another program, so the desk service can't run there. The user sets the desk plugin's port option (or DESK_PORT) to a free port and runs /reload; if it's an older desk service, they stop it instead.`;

/**
 * Whether the WebSocket couldn't even open (not for lack of time): an upgrade refused, as by a server that isn't the
 * desk's. Nothing listening fails the same way, and so does a desk service that's only starting (it listens a moment
 * before it serves `/rpc`), so it counts only while the port takes connections and keeps refusing (`upgrades`).
 */
const refused = (error: RpcClientError.RpcClientError) =>
	error.reason._tag === "SocketOpenError" && error.reason.kind !== "Timeout";

/** Whether a WebSocket to `url` opens: it connects, and hangs up at once. */
const upgrades = (url: string): Effect.Effect<boolean> =>
	Socket.makeWebSocket(url, { openTimeout: "1 second" }).pipe(
		Effect.flatMap((socket) => socket.reader),
		Effect.scoped,
		Effect.as(true),
		Effect.orElseSucceed(() => false),
		Effect.provide(BunSocket.layerWebSocketConstructor),
	);

/** Whether something listens on `port` (on 127.0.0.1): connects, and hangs up at once. */
export const answering = (port: number): Effect.Effect<boolean> =>
	BunSocket.makeNet({ host: "127.0.0.1", port }).pipe(
		Effect.flatMap((socket) => socket.reader),
		Effect.scoped,
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

/** The connection, off until wanted; hangs up when the scope closes. */
export const make = <R = never>(options: Options<R>): Effect.Effect<Connection, never, Scope.Scope | R> =>
	Effect.gen(function* () {
		const url = `ws://127.0.0.1:${options.port}${rpcPath}`;
		const transport = RpcClient.layerProtocolSocket().pipe(
			Layer.provide(BunSocket.layerWebSocket(url)),
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

		/** Nothing listens: start the service and wait until it does. */
		const ensure = Effect.gen(function* () {
			if (yield* answering(options.port)) return;
			yield* options.start;
			yield* answering(options.port).pipe(
				Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (up) => up }),
				Effect.timeoutOrElse({
					duration: options.timeout ?? "10 seconds",
					orElse: () =>
						Effect.fail(new DeskError({ message: `The desk service didn't start (port ${options.port}).` })),
				}),
			);
		});

		/** One link, for as long as it lasts: hello, then the attachment, answering the calls that come on it. */
		const link = (emit: (event: Event) => Effect.Effect<void>) =>
			Effect.gen(function* () {
				yield* ensure;
				const client = yield* RpcClient.make(DeskApi);
				const greeted = yield* client.hello({ protocol }).pipe(
					// Something that doesn't speak this protocol at all answers nothing: try again later rather than wait for good.
					Effect.timeoutOrElse({
						duration: "5 seconds",
						orElse: () =>
							Effect.fail(new DeskError({ message: `The desk service on port ${options.port} doesn't answer hello.` })),
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
					// Something listens, but the upgrade was refused. Still refusing two seconds on (not a desk service on its
					// way up), and still listening (not one on its way out), it isn't the desk's. Otherwise: next time round.
					Effect.catchTag("RpcClientError", (error) =>
						refused(error)
							? Effect.gen(function* () {
									const opened = yield* Effect.andThen(Effect.sleep("250 millis"), upgrades(url)).pipe(
										Effect.repeat({ until: (opened) => opened, times: 7 }),
									);
									if (opened || !(yield* answering(options.port))) return yield* error;
									yield* emit(Event.Taken({ message: taken(options.port) }));
									return Option.none<string>();
								})
							: Effect.fail(error),
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

		const actor = yield* Machine.start<State, Event, R>({
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
			links: actor.changes.pipe(
				Stream.map(
					(state): Option.Option<Link> =>
						state._tag === "Live" ? Option.some({ client: state.client, url: state.url }) : Option.none(),
				),
				Stream.changesWith(sameLink),
			),
		};
		return connection;
	});

/**
 * Starts `bun src/service/main.ts` detached, on `store` and `port`, logging to `log`,
 * which it gets as its own stdout and stderr. With `node:child_process`, not Effect's `ChildProcess`: that one can
 * detach and unref a child, but its output goes to a pipe (or a sink) in this process, which breaks when this OpenCode
 * exits, and the service outlives it. Nor does Effect's `FileSystem` hand out the file descriptor `spawn` needs. The
 * log is closed here once the child has it.
 */
export const startService = (service: { readonly store: string; readonly port: number; readonly log: string }) =>
	Effect.gen(function* () {
		const main = yield* (yield* Path.Path).fromFileUrl(new URL("../service/main.ts", import.meta.url));
		yield* Effect.acquireUseRelease(
			Effect.sync(() => {
				mkdirSync(service.store, { recursive: true });
				return openSync(service.log, "a");
			}),
			(log) =>
				Effect.sync(() => {
					// Inside OpenCode, `process.execPath` is OpenCode's own binary, which runs as Bun with BUN_BE_BUN.
					const bun = Bun.which("bun");
					spawn(bun ?? process.execPath, [main], {
						detached: true,
						stdio: ["ignore", log, log],
						env: {
							...process.env,
							DESK_HOME: service.store,
							DESK_PORT: String(service.port),
							...(bun ? {} : { BUN_BE_BUN: "1" }),
						},
					}).unref();
				}),
			(log) => Effect.sync(() => closeSync(log)),
		);
	});
