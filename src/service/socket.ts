/**
 * The service's Unix socket, where plugin instances connect (`protocol.ts`). The registration (`registration.ts`) is
 * what keeps the store to one service; this checks once more that nobody answers on the socket before replacing a
 * stale socket file (a crashed service's).
 *
 * Each connection is a client (`Clients`) until it closes. Its `hello` attaches it to `OpenCode` for that long: the
 * service then calls the plugin instance (`Calls`) to look up and prompt sessions in its OpenCode.
 */
import { statSync, unlinkSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Data from "effect/Data";
import { type Client, OpenCode } from "../opencode";
import { Projects } from "../projects";
import { type Call, type CallMethod, type CallResult, type Calls, calls, contractFiles, decode, methods, protocol, type Request, type Response } from "../protocol";
import { Api } from "./api";
import { Clients } from "./clients";

export class AlreadyRunning extends Data.TaggedError("AlreadyRunning")<{ readonly path: string }> {}

/** Whether a service answers on `path`. */
export const answering = (path: string) =>
	Bun.connect({ unix: path, socket: { data() {} } }).then(
		(socket) => {
			socket.end();
			return true;
		},
		() => false,
	);

interface Connection {
	buffer: string;
	/** Output the socket hasn't taken yet. */
	pending: string;
	scope: Scope.Closeable;
	/** The plugin instance, acting in its OpenCode. */
	client: Client;
	/** Calls waiting for the plugin's answer. */
	calls: Map<number, { resolve: (output: unknown) => void; reject: (error: Error) => void }>;
}

/** How long a call may wait for the plugin's answer. */
const callTimeout = 30_000;

/**
 * Whether this service's contract is the outdated one: its files changed on disk after the service started. The plugin
 * always starts the service from the code on disk, so then the service makes way; otherwise the plugin is behind.
 */
export const changedSinceStart = (started = Date.now()) => () =>
	contractFiles.some((file) => {
		try {
			return statSync(file).mtimeMs > started;
		} catch {
			return false;
		}
	});

export const layer = (path: string, outdated: () => boolean = changedSinceStart()) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const api = yield* Api;
			const opencode = yield* OpenCode;
			const projects = yield* Projects;
			const clients = yield* Clients;
			const services = yield* Effect.context<never>();
			const run = Effect.runForkWith(services);

			const handle = (connection: Connection, request: Request): Effect.Effect<unknown, { message: string }> => {
				const input = <M extends keyof typeof methods & string>(name: M) => decode(methods, name, "input", request.input);
				switch (request.method) {
					case "hello": {
						// The version first, read leniently: an older plugin may speak a hello this service can't decode.
						const theirs = String((request.input as { protocol?: unknown } | null)?.protocol ?? "");
						return Effect.gen(function* () {
							if (theirs !== protocol && outdated()) {
								// This service is the old side: make way for the one the plugin starts from the code on disk. The reply goes out first.
								run(Effect.andThen(Effect.sleep("100 millis"), clients.retire));
								return yield* Effect.fail({ message: "The desk service is older than this plugin; it's making way for a new one." });
							}
							if (theirs !== protocol) return yield* Effect.fail({ message: "This OpenCode's desk plugin is older than the desk service: run /reload." });
							const { project } = yield* input("hello");
							yield* Scope.provide(opencode.attach(connection.client), connection.scope);
							if (project) yield* projects.remember(project.id, project.directory);
							return { url: api.url };
						});
					}
					case "moved":
						return Effect.flatMap(input("moved"), ({ session }) => opencode.move(session)).pipe(Effect.as(null));
					case "ask":
					case "adopt":
					case "answer":
					case "resolve":
					case "prioritize":
					case "list":
					case "page":
						return Effect.flatMap(input(request.method), (decoded) => (api as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, { message: string }>>)[request.method]!(decoded));
					default:
						return Effect.fail({ message: `Unknown method ${String((request as { method: unknown }).method)}.` });
				}
			};

			const flush = (socket: Bun.Socket<Connection>) => {
				const { pending } = socket.data;
				if (!pending) return;
				const written = socket.write(pending);
				socket.data.pending = pending.slice(Math.max(written, 0));
			};
			const write = (socket: Bun.Socket<Connection>, message: Response | Call) => {
				socket.data.pending += `${JSON.stringify(message)}\n`;
				flush(socket);
			};

			let lastCall = 0;
			const call = <C extends CallMethod>(socket: Bun.Socket<Connection>, method: C, input: Calls[C]["input"]) =>
				new Promise<Calls[C]["output"]>((resolve, reject) => {
					const id = ++lastCall;
					const timer = setTimeout(() => settle(new Error(`The plugin didn't answer ${method} in time.`)), callTimeout);
					const settle = (error: Error | undefined, output?: unknown) => {
						clearTimeout(timer);
						socket.data.calls.delete(id);
						if (error) reject(error);
						else Effect.runPromise(decode(calls, method, "output", output)).then(resolve, (failure: { message: string }) => reject(new Error(failure.message)));
					};
					socket.data.calls.set(id, { resolve: (output) => settle(undefined, output), reject: settle });
					write(socket, { call: id, method, input });
				});
			const client = (socket: Bun.Socket<Connection>): Client => ({
				session: async (sessionID) => (await call(socket, "session", { sessionID })) ?? undefined,
				prompt: async (prompt) => void (await call(socket, "prompt", prompt)),
			});

			if (yield* Effect.promise(() => answering(path))) return yield* new AlreadyRunning({ path });
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					try {
						unlinkSync(path);
					} catch {}
					return Bun.listen<Connection>({
						unix: path,
						socket: {
							open(socket) {
								const scope = Effect.runSync(Scope.make());
								socket.data = { buffer: "", pending: "", scope, client: client(socket), calls: new Map() };
								run(Scope.provide(clients.hold, scope));
							},
							data(socket, chunk) {
								socket.data.buffer += chunk.toString();
								const lines = socket.data.buffer.split("\n");
								socket.data.buffer = lines.pop()!;
								for (const line of lines) {
									if (!line.trim()) continue;
									let message: Request | CallResult;
									try {
										message = JSON.parse(line);
									} catch {
										continue;
									}
									if ("call" in message) {
										const waiting = socket.data.calls.get(message.call);
										if ("error" in message) waiting?.reject(new Error(message.error));
										else waiting?.resolve(message.output);
										continue;
									}
									const request = message;
									run(
										handle(socket.data, request).pipe(
											Effect.match({
												onSuccess: (output) => write(socket, { id: request.id, output: output ?? null }),
												onFailure: (error) => write(socket, { id: request.id, error: error.message }),
											}),
										),
									);
								}
							},
							drain: flush,
							close(socket) {
								for (const waiting of [...socket.data.calls.values()]) waiting.reject(new Error("The plugin instance went away."));
								run(Scope.close(socket.data.scope, Exit.void));
							},
						},
					});
				}),
				(listener) =>
					Effect.sync(() => {
						listener.stop(true);
						try {
							unlinkSync(path);
						} catch {}
					}),
			);
		}),
	);
