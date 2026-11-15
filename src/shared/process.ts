/** Process primitives Effect lacks: a file descriptor of one's own, a detached child that outlives this process, `which`. */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

/**
 * `path` opened for appending (created if missing), as a file descriptor, closed when the scope closes. Effect's
 * `FileSystem` opens files as its own `File`, which doesn't hand out the descriptor.
 */
export const openForAppend = (path: string) =>
	Effect.acquireRelease(
		Effect.try({
			try: () => openSync(path, "a"),
			catch: (cause) =>
				PlatformError.systemError({
					_tag: "Unknown",
					module: "FileSystem",
					method: "openForAppend",
					pathOrDescriptor: path,
					cause,
				}),
		}),
		(fd) => Effect.sync(() => closeSync(fd)),
	);

export interface Detached {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	/** A file descriptor for its stdout and stderr; it has its own copy, so this one can be closed once it's started. */
	readonly output: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Starts a process that outlives this one: detached, unref'd, stdin ignored, its output to a file descriptor. Not
 * Effect's `ChildProcess`: that one can detach and unref a child, but its output goes to a pipe (or a sink) in this
 * process, which breaks when this process exits.
 */
export const spawnDetached = (process: Detached) =>
	Effect.try({
		try: () => {
			spawn(process.command, [...process.args], {
				detached: true,
				stdio: ["ignore", process.output, process.output],
				env: process.env,
			}).unref();
		},
		catch: (cause) =>
			PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawnDetached", cause }),
	});

/** Where `command` is on the `PATH`, if it is. */
export const which = (command: string) => Effect.sync(() => Option.fromNullOr(Bun.which(command)));
