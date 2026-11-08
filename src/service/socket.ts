/**
 * The service's Unix socket, where plugin instances connect (`protocol.ts`). It's also the lock that keeps the
 * service to one per machine: a second service finds the first answering on it and leaves; a socket file nobody
 * answers on is stale (a crashed service) and gets replaced.
 *
 * Each connection is a client (`Clients`) until it closes; its `hello` attaches its OpenCode server for that long.
 */
import { unlinkSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Data from "effect/Data";
import { OpenCode } from "../opencode";
import { Projects } from "../projects";
import type { Methods, Request, Response } from "../protocol";
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
}

export const layer = (path: string) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const api = yield* Api;
			const opencode = yield* OpenCode;
			const projects = yield* Projects;
			const clients = yield* Clients;
			const services = yield* Effect.context<never>();
			const run = Effect.runForkWith(services);

			const handle = (connection: Connection, request: Request): Effect.Effect<unknown, { message: string }> => {
				switch (request.method) {
					case "hello": {
						const { opencode: endpoint, project } = request.input as Methods["hello"]["input"];
						return Effect.gen(function* () {
							if (endpoint) yield* Scope.provide(opencode.attach(endpoint), connection.scope);
							if (project) yield* projects.remember(project.id, project.directory);
							return { url: api.url };
						});
					}
					case "ask":
					case "adopt":
					case "answer":
					case "resolve":
					case "prioritize":
					case "list":
					case "page":
						return (api[request.method] as (input: unknown) => Effect.Effect<unknown, { message: string }>)(request.input);
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
			const reply = (socket: Bun.Socket<Connection>, response: Response) => {
				socket.data.pending += `${JSON.stringify(response)}\n`;
				flush(socket);
			};

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
								socket.data = { buffer: "", pending: "", scope };
								run(Scope.provide(clients.hold, scope));
							},
							data(socket, chunk) {
								socket.data.buffer += chunk.toString();
								const lines = socket.data.buffer.split("\n");
								socket.data.buffer = lines.pop()!;
								for (const line of lines) {
									if (!line.trim()) continue;
									let request: Request;
									try {
										request = JSON.parse(line);
									} catch {
										continue;
									}
									run(
										handle(socket.data, request).pipe(
											Effect.match({
												onSuccess: (output) => reply(socket, { id: request.id, output: output ?? null }),
												onFailure: (error) => reply(socket, { id: request.id, error: error.message }),
											}),
										),
									);
								}
							},
							drain: flush,
							close(socket) {
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
