/**
 * A plugin instance's connection to the desk service: an RPC client of `DeskApi` (`api.ts`) over a WebSocket to the
 * service's port (`ws://127.0.0.1:<port>/rpc`), the port setting's. While it's needed (a session here is in desk
 * mode), it starts the service (detached, so it outlives this OpenCode) when nothing listens there, says `hello`, and
 * holds `attach` open, answering the service's calls into this OpenCode (`serve`) as they come on it. When the service
 * goes, it does it all again, starting a new one; requests wait for that.
 *
 * Something else may have the port: then the WebSocket's upgrade fails while the port still takes connections, and the
 * agents are told so (`taken`), rather than waiting for a service that can't start there. If it's a desk service that
 * refuses the plugin's token (the Keychain's changed while it ran), they're told that instead (`unauthorized`).
 *
 * A machine (`machine.ts`): `Off`; `Connecting` and then `Live`, on one WebSocket (one `run`, the `link`); `Backoff` a
 * moment after the link drops; `Refused` while this plugin is older than the service or another program has the port,
 * or the service there doesn't take this plugin's token, until it's turned off.
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Cause from "effect/Cause";
import type * as Config from "effect/Config";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { DeskApi, type Outcome, type Prompt, type ServiceCall, type SessionInfo } from "../api/api";
import { protocol } from "../api/protocol";
import { challenge, host, rpcUrl, serviceUrl, withToken } from "../api/routes";
import type { SessionID } from "../model/entry";
import type { AbsolutePath, Port } from "../model/paths";
import type { Empty } from "../shared/empty";
import * as Machine from "../shared/machine";
import * as Process from "../shared/process";
import type { SecretsError } from "../shared/secrets";
import * as Settings from "../shared/settings";
import type { Failure, OpenCodeError } from "./sessions";

/** The service can't be reached, or won't take this plugin (the message says why). */
export class DeskError extends Data.TaggedError("DeskError")<{ readonly message: string }> {}

export interface Client extends RpcClient.FromGroup<typeof DeskApi, RpcClientError.RpcClientError> {}

/** `R`: what starting the service needs. */
export interface Options<R = never> {
	/** The service's port, on {@link host}. */
	readonly port: Port;
	/** Starts the service; run when nothing listens on the port. */
	readonly start: Effect.Effect<void, PlatformError.PlatformError | Config.ConfigError | Settings.InvalidSetting, R>;
	/** The service's `service.json`, whose pid the user can kill (what a refusal tells them). */
	readonly registration: AbsolutePath;
	/** This plugin instance's directory. */
	readonly directory: AbsolutePath;
	/** The store's token (`token.ts`), read as each link starts: the service makes it the first time it runs. */
	readonly token: Effect.Effect<Redacted.Redacted<string>, SecretsError>;
	/** The sessions in desk mode, reported on every attach (the service holds them only while attached). */
	readonly modes: Effect.Effect<ReadonlyArray<SessionID>>;
	/** Answers the service's calls, in this OpenCode. */
	readonly serve: {
		/** Null when this OpenCode doesn't know the session. */
		readonly session: (sessionID: SessionID) => Effect.Effect<SessionInfo | null, OpenCodeError>;
		readonly prompt: (prompt: Prompt) => Effect.Effect<void, Failure>;
	};
	/**
	 * How long to wait for a started service to answer.
	 * @default "10 seconds"
	 */
	readonly timeout?: Duration.Input;
	/**
	 * Needed from the start, else off until {@link Connection.needsConnection}.
	 * @default false
	 */
	readonly needed?: boolean;
}

/** A live link: the service's API, its page's URL from its answer to `hello`, and the token it was let in with. */
export interface Link {
	readonly client: Client;
	readonly url: URL;
	readonly token: Redacted.Redacted<string>;
}

export interface Connection {
	/**
	 * Whether this plugin instance needs the service: true connects (starting it if needed) and keeps reconnecting;
	 * false hangs up. Done once the connection has taken it in.
	 */
	readonly needsConnection: (needed: boolean) => Effect.Effect<void>;
	/** The service's API, once connected; fails at once while off or refused. */
	readonly client: Effect.Effect<Client, DeskError>;
	/** The service's API if connected right now. */
	readonly live: Effect.Effect<Option.Option<Client>>;
	/** The page's URL, from the service's answer to `hello`. */
	readonly url: Effect.Effect<URL, DeskError>;
	/** `url` with the token, once connected: a link that lets the user's browser in (`routes.ts`'s `withToken`). */
	readonly authorize: (url: URL) => Effect.Effect<URL, DeskError>;
	/** The live link now (none while not connected), then each new one, and none whenever it drops. */
	readonly links: Stream.Stream<Option.Option<Link>>;
}

/** The same link (the same client), or none both times. */
const sameLink = Option.makeEquivalence(
	Equivalence.mapInput(Equivalence.strictEqual<Client>(), (link: Link) => link.client),
);

export type State = Data.TaggedEnum<{
	Off: Empty;
	Connecting: Empty;
	Live: Link;
	/** Why the link dropped. */
	Backoff: { readonly message: string };
	Refused: { readonly message: string };
}>;
export const State = Data.taggedEnum<State>();

export type Event = Data.TaggedEnum<{
	/** Whether this plugin instance needs the service ({@link Connection.needsConnection}). */
	Need: { readonly needed: boolean };
	/** The service answered `hello`. */
	Hello: Link;
	/** The link ended: the service went, or couldn't be started or greeted. */
	Dropped: { readonly message: string };
	/** The service won't take this plugin: it's older. */
	Outdated: { readonly message: string };
	/** Another program has the port. */
	Taken: { readonly message: string };
	/** The desk service there doesn't accept this plugin's token. */
	Unauthorized: { readonly message: string };
	/** `Backoff` is over. */
	Retry: Empty;
}>;
export const Event = Data.taggedEnum<Event>();

export const reconcile = (state: State, event: Event): State => {
	switch (event._tag) {
		case "Need":
			return !event.needed ? State.Off() : state._tag === "Off" ? State.Connecting() : state;
		case "Hello":
			return state._tag === "Connecting"
				? State.Live({ client: event.client, url: event.url, token: event.token })
				: state;
		case "Dropped":
			return state._tag === "Connecting" || state._tag === "Live" ? State.Backoff({ message: event.message }) : state;
		case "Outdated":
		case "Taken":
		case "Unauthorized":
			return state._tag === "Connecting" ? State.Refused({ message: event.message }) : state;
		case "Retry":
			return state._tag === "Backoff" ? State.Connecting() : state;
	}
};

/** `Connecting` and `Live` are one link: one WebSocket, one `run`. */
export const key = (state: State): State["_tag"] => (state._tag === "Live" ? "Connecting" : state._tag);

/** Whether the connection has taken in `Need({ needed })`: `Off` when not needed, anything but `Off` when needed. */
const settled = (needed: boolean) => (state: State) => (state._tag === "Off") !== needed;

const off = "Desk mode is off in this directory; the user turns it on with /desk-mode.";

/** A failure's message, whatever was thrown. */
export const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: Predicate.isObject(error) && Predicate.hasProperty(error, "message")
			? String(error.message)
			: String(error);

/** What the agents are told while another program has `port`. */
export const taken = (port: Port) =>
	`Port ${port} is taken by another program, so the desk service can't run there. The user sets the desk plugin's port option (or DESK_PORT) to a free port and runs /reload; if it's an older desk service, they stop it instead.`;

/** What the agents are told while the desk service on `port` refuses this plugin's token: the Keychain's changed while it ran. */
export const unauthorized = (port: Port, registration: AbsolutePath) =>
	`The desk service on port ${port} didn't accept this OpenCode's token: the token in the Keychain changed while it ran. Restart the desk service (kill the pid in ${registration}) and /reload.`;

/**
 * Whether the desk service on `port` refuses `token`: a plain request to its page answers 401 with the desk's
 * challenge (`routes.ts`). Another program refusing the upgrade doesn't answer that way, and neither does one that can't
 * be reached.
 */
const refusesToken = (port: Port, token: Redacted.Redacted<string>) =>
	Effect.tryPromise(async () => {
		const response = await fetch(serviceUrl(port), {
			headers: authorization(token),
			redirect: "manual",
			signal: AbortSignal.timeout(1000),
		});
		return response.status === 401 && response.headers.get("www-authenticate") === challenge;
	}).pipe(Effect.orElseSucceed(() => false));

/**
 * Whether the WebSocket couldn't even open (not for lack of time): an upgrade refused, as by a server that isn't the
 * desk's. Nothing listening fails the same way, and so does a desk service that's only starting (it listens a moment
 * before it serves `/rpc`), so it counts only while the port takes connections and keeps refusing (`upgrades`).
 */
const refused = (error: RpcClientError.RpcClientError) =>
	error.reason._tag === "SocketOpenError" && error.reason.kind !== "Timeout";

/** The bearer header a plugin is let in by. */
const authorization = (token: Redacted.Redacted<string>) => ({ authorization: `Bearer ${Redacted.value(token)}` });

/** Whether a WebSocket to `url` opens, with `token`: it connects, and hangs up at once. */
const upgrades = (url: string, token: Redacted.Redacted<string>) =>
	Socket.makeWebSocket(url, { openTimeout: "1 second", headers: authorization(token) }).pipe(
		Effect.flatMap((socket) => socket.reader),
		Effect.scoped,
		Effect.as(true),
		Effect.orElseSucceed(() => false),
		Effect.provide(BunSocket.layerWebSocketConstructor),
	);

/** Whether something listens on `port` (on {@link host}): connects, and hangs up at once. */
export const answering = (port: Port) =>
	BunSocket.makeNet({ host, port }).pipe(
		Effect.flatMap((socket) => socket.reader),
		Effect.scoped,
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

/** The connection, off until needed; hangs up when the scope closes. */
export const make = Effect.fn("Connection.make")(function* <R = never>(options: Options<R>) {
	const url = rpcUrl(options.port).href;
	const transport = (token: Redacted.Redacted<string>) =>
		RpcClient.layerProtocolSocket().pipe(
			Layer.provide(BunSocket.layerWebSocket(url, { headers: authorization(token) })),
			Layer.provide(RpcSerialization.layerNdjson),
		);

	/** Answers one of the service's calls, in this OpenCode; a failure is the answer, not the connection's. */
	const answer = (client: Client, call: ServiceCall) =>
		(call._tag === "Session"
			? Effect.map(options.serve.session(call.sessionID), (session): Outcome => ({ _tag: "Session", session }))
			: Effect.as(options.serve.prompt(call.prompt), { _tag: "Prompted" } as Outcome)
		).pipe(
			Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Failed", cause: error.message })),
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
				orElse: () => Effect.fail(new DeskError({ message: `The desk service didn't start (port ${options.port}).` })),
			}),
		);
	});

	/** One link, for as long as it lasts: the service (started if need be), then the link, let in by the token. */
	const link = Effect.fn("link")(
		function* (emit: (event: Event) => Effect.Effect<void>) {
			yield* ensure;
			yield* attached(emit, yield* options.token);
		},
		(effect, emit) =>
			Effect.catchCause(effect, (cause) => emit(Event.Dropped({ message: errorMessage(Cause.squash(cause)) }))),
	);

	/** Hello, then the attachment, answering the calls that come on it. */
	const attached = Effect.fn("attached")(
		function* (emit: (event: Event) => Effect.Effect<void>, token: Redacted.Redacted<string>) {
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
								Option.none<URL>(),
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
								const opened = yield* Effect.andThen(Effect.sleep("250 millis"), upgrades(url, token)).pipe(
									Effect.repeat({ until: (opened) => opened, times: 7 }),
								);
								if (opened || !(yield* answering(options.port))) return yield* error;

								yield* emit(
									(yield* refusesToken(options.port, token))
										? Event.Unauthorized({ message: unauthorized(options.port, options.registration) })
										: Event.Taken({ message: taken(options.port) }),
								);
								return Option.none<URL>();
							})
						: Effect.fail(error),
				),
			);
			if (Option.isNone(greeted)) return;

			yield* emit(Event.Hello({ client, url: greeted.value, token }));
			yield* client
				.attach({ directory: options.directory, sessions: yield* options.modes })
				.pipe(Stream.runForEach((call) => Effect.forkScoped(answer(client, call))));
			yield* emit(Event.Dropped({ message: "The desk service hung up." }));
		},
		Effect.scoped,
		(effect, _emit, token) => Effect.provide(effect, transport(token)),
	);

	const actor = yield* Machine.start<State, Event, R>({
		initial: options.needed ? State.Connecting() : State.Off(),
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
	const awaitLink = actor.until(
		(state): Option.Option<Effect.Effect<Link, DeskError>> =>
			state._tag === "Live"
				? Option.some(Effect.succeed(state))
				: state._tag === "Off" || state._tag === "Refused"
					? Option.some(Effect.fail(new DeskError({ message: state._tag === "Off" ? off : state.message })))
					: Option.none(),
	);
	const live = Effect.flatten(awaitLink);
	const connection: Connection = {
		needsConnection: (needed) =>
			actor
				.send(Event.Need({ needed }))
				.pipe(Effect.andThen(actor.until(Option.liftPredicate(settled(needed)))), Effect.asVoid),
		client: Effect.map(live, (now) => now.client),
		live: Effect.map(actor.state, (state) => (state._tag === "Live" ? Option.some(state.client) : Option.none())),
		url: Effect.map(live, (now) => now.url),
		authorize: (page) => Effect.map(live, (now) => withToken(page, now.token)),
		links: actor.changes.pipe(
			Stream.map(
				(state): Option.Option<Link> =>
					state._tag === "Live"
						? Option.some({ client: state.client, url: state.url, token: state.token })
						: Option.none(),
			),
			Stream.changesWith(sameLink),
		),
	};
	return connection;
});

/**
 * Starts `bun src/service/main.ts` detached (`Process.spawnDetached`: it outlives this OpenCode), with this plugin's
 * `options` as it got them (`--options '<json>'`: the service reads them as the plugin does, before the environment),
 * logging to the store's log (`Settings.files`), which it gets as its own stdout and stderr. All but the `token`
 * option: that one goes in its environment (`DESK_TOKEN`), where other users' processes can't read it, as they can arguments.
 */
export const startService = Effect.fn("startService")(function* (options: Settings.Options) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const main = path.resolve(import.meta.dir, "../service/main.ts");
	const { store, log } = yield* Settings.files;
	const { token, ...rest } = options;
	yield* fs.makeDirectory(store, { recursive: true });

	// Inside OpenCode, `process.execPath` is OpenCode's own binary, which runs as Bun with BUN_BE_BUN.
	const bun = yield* Process.which("bun");
	yield* Process.spawnDetached({
		command: Option.getOrElse(bun, () => process.execPath),
		args: [main, "--options", JSON.stringify(rest)],
		output: yield* Process.openForAppend(log),
		env: {
			...process.env,
			...(Option.isSome(bun) ? {} : { BUN_BE_BUN: "1" }),
			...(token === undefined ? {} : { DESK_TOKEN: String(token) }),
		},
	});
}, Effect.scoped);
