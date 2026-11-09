/**
 * A plugin instance's connection to the desk service: connects to its socket, starting the service (detached, so it
 * outlives this OpenCode) when nobody answers, says `hello`, and holds the connection while the plugin is loaded. If
 * the service goes away it reconnects, starting a new one, and says `hello` again; requests wait for that.
 *
 * The service calls back on the same connection (`Calls`): `serve` answers them, in this OpenCode.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { type Call, type CallMethod, type CallResult, type Calls, calls, decode, type Method, type Methods, type Response } from "../protocol";

/** The service can't be reached, or it refused the request (its message says why). */
export class DeskError extends Data.TaggedError("DeskError")<{ readonly message: string }> {}

export interface Options {
	readonly socket: string;
	/** Starts the service; run when nothing answers on the socket. */
	readonly start: Effect.Effect<void>;
	readonly hello: Methods["hello"]["input"];
	/** The sessions in desk mode, reported after every hello (the service holds them only while connected). */
	readonly modes?: Effect.Effect<ReadonlyArray<string>> | undefined;
	/** Answers the service's calls. */
	readonly serve: { readonly [C in CallMethod]: (input: Calls[C]["input"]) => Effect.Effect<Calls[C]["output"], unknown> };
	/** How long to wait for a started service to answer. */
	readonly timeout?: Duration.Input;
}

export interface Connection {
	readonly request: <M extends Method>(method: M, input: Methods[M]["input"]) => Effect.Effect<Methods[M]["output"], DeskError>;
	/** The page's URL, from the service's answer to `hello`. */
	readonly url: Effect.Effect<string, DeskError>;
}

type Socket = Bun.Socket<undefined>;

interface Live {
	readonly socket: Socket;
	readonly url: string;
	/** Completes when the service hangs up. */
	readonly closed: Deferred.Deferred<void>;
}

/** A failure's message, whatever was thrown. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));

/** Connects for as long as the scope is open. */
export const make = (options: Options): Effect.Effect<Connection, never, Scope.Scope> =>
	Effect.gen(function* () {
		const run = yield* FiberSet.makeRuntime<never>();
		const waiting = new Map<number, Deferred.Deferred<unknown, DeskError>>();
		let next = 0;
		/** The live connection, or the one being made: requests wait for it. */
		const current = yield* Ref.make(yield* Deferred.make<Live, DeskError>());
		let socket: Socket | undefined;

		/** Answers one of the service's calls. */
		const answer = (to: Socket, call: Call) =>
			decode(calls, call.method, "input", call.input).pipe(
				Effect.flatMap((input) => (options.serve[call.method] as (input: unknown) => Effect.Effect<unknown, unknown>)(input)),
				Effect.match({
					onSuccess: (output): CallResult => ({ call: call.call, output: output ?? null }),
					onFailure: (error): CallResult => ({ call: call.call, error: errorMessage(error) }),
				}),
				Effect.flatMap((result) => Effect.sync(() => to.write(`${JSON.stringify(result)}\n`))),
			);

		const dial = (closed: Deferred.Deferred<void>) =>
			Effect.tryPromise({
				try: () => {
					let buffer = "";
					return Bun.connect({
						unix: options.socket,
						socket: {
							data(to, chunk) {
								buffer += chunk.toString();
								const lines = buffer.split("\n");
								buffer = lines.pop()!;
								for (const line of lines) {
									if (!line.trim()) continue;
									const received = JSON.parse(line) as Response | Call;
									if ("call" in received) {
										run(answer(to, received));
										continue;
									}
									const pending = waiting.get(received.id);
									if (!pending) continue;
									run("error" in received ? Deferred.fail(pending, new DeskError({ message: received.error })) : Deferred.succeed(pending, received.output));
								}
							},
							close() {
								run(Deferred.succeed(closed, undefined));
							},
						},
					});
				},
				catch: () => new DeskError({ message: `Nothing answers on ${options.socket}.` }),
			});

		const send = <M extends Method>(to: Socket, method: M, input: Methods[M]["input"]) =>
			Effect.suspend(() => {
				const id = ++next;
				return Effect.gen(function* () {
					const pending = yield* Deferred.make<unknown, DeskError>();
					waiting.set(id, pending);
					to.write(`${JSON.stringify({ id, method, input })}\n`);
					return (yield* Deferred.await(pending)) as Methods[M]["output"];
				}).pipe(Effect.ensuring(Effect.sync(() => waiting.delete(id))));
			});

		/** Dials, or starts the service and dials until it answers; then says hello. */
		const open = Effect.gen(function* () {
			const closed = yield* Deferred.make<void>();
			const dialed = yield* dial(closed).pipe(
				Effect.catch(() =>
					options.start.pipe(
						Effect.andThen(dial(closed).pipe(Effect.retry(Schedule.spaced("50 millis")))),
						Effect.timeoutOrElse({
							duration: options.timeout ?? "10 seconds",
							orElse: () => Effect.fail(new DeskError({ message: `The desk service didn't start (socket ${options.socket}).` })),
						}),
					),
				),
			);
			socket = dialed;
			const { url } = yield* send(dialed, "hello", options.hello);
			if (options.modes) yield* send(dialed, "modes", { sessions: yield* options.modes });
			return { socket: dialed, url, closed } satisfies Live;
		});

		/** Holds a connection: makes it, waits until it closes, makes the next. Requests that were waiting on a closed one fail. */
		const hold = Effect.gen(function* () {
			const pending = yield* Ref.get(current);
			const opened = yield* Effect.exit(open);
			if (opened._tag === "Success") {
				yield* Deferred.succeed(pending, opened.value);
				yield* Deferred.await(opened.value.closed);
				for (const [id, waiter] of waiting) {
					waiting.delete(id);
					yield* Deferred.fail(waiter, new DeskError({ message: "The desk service went away; try again." }));
				}
			} else yield* Deferred.failCause(pending, opened.cause);
			yield* Ref.set(current, yield* Deferred.make<Live, DeskError>());
			yield* Effect.sleep("500 millis");
		}).pipe(Effect.forever);

		yield* Effect.addFinalizer(() => Effect.sync(() => socket?.end()));
		yield* Effect.forkScoped(hold);

		// A connection attempt that just failed (the service was restarting) isn't the last word: wait for the next one.
		const live = Effect.flatMap(Ref.get(current), Deferred.await).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 60 }));
		return {
			request: (method, input) => Effect.flatMap(live, (connection) => send(connection.socket, method, input)),
			url: Effect.map(live, (connection) => connection.url),
		} satisfies Connection;
	});

/** Starts `bun src/service/main.ts` detached, logging to `<store>/service.log`. */
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
