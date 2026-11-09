/**
 * The service's registration, `<store>/service.json`: the lock that keeps the store to one service, and what the
 * running service is (`Info`, `service-info.ts`), as OpenCode's own `service.json` is.
 *
 * A service creates the file exclusively when it starts. If it exists and names a live process, another service has
 * the store and this one leaves (`AlreadyRunning`); if that process is gone, the file is stale and replaced, by one
 * service at a time (`<store>/service.json.takeover`, a directory made exclusively). The file goes when the service
 * stops. A port, configured or not, doesn't decide anything: the page takes whichever port it can and writes it here.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { protocol } from "../protocol";
import { decode, encode, type Info } from "../service-info";

export class AlreadyRunning extends Data.TaggedError("AlreadyRunning")<{
	readonly path: string;
	readonly pid: number;
}> {}

/** Whether a process exists. Effect has no way to ask, so this is `kill(pid, 0)`. */
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, it's just not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export class Registration extends Context.Service<
	Registration,
	{
		/** Records where the page and the socket are, once they are. */
		readonly publish: (where: { readonly url: string; readonly socket: string }) => Effect.Effect<void>;
	}
>()("desk/Registration") {
	/** Takes the store's lock for the layer's lifetime, or fails with `AlreadyRunning`. */
	static layer(store: string) {
		const own: Info = { pid: process.pid, protocol };
		return Layer.effect(
			Registration,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = (yield* Path.Path).join(store, "service.json");
				/** The registration there now; undefined when there's none or it isn't one. */
				const read = fs.readFileString(path).pipe(
					Effect.flatMap(decode),
					Effect.option,
					Effect.map((info) => (info._tag === "Some" ? info.value : undefined)),
				);
				// Whole or not at all: written beside it, then linked into place (failing if it exists). Created empty and then
				// written, a reader in between would take the empty file for a dead service's, remove it and take the lock.
				const create = Effect.gen(function* () {
					const temp = `${path}.${process.pid}.new`;
					yield* fs.writeFileString(temp, encode(own));
					yield* fs.link(temp, path).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp))));
				});
				const taken = (pid: number) => new AlreadyRunning({ path, pid });
				const exists = (error: { readonly _tag: string; readonly reason?: { readonly _tag: string } }) =>
					error._tag === "PlatformError" && error.reason?._tag === "AlreadyExists";
				/**
				 * Replacing a dead service's file, one service at a time: whoever makes this directory. Only a service holding
				 * it removes the file, after reading it again: two removing at once, one could remove the other's fresh file,
				 * and both would hold the store. One left by a service that crashed while replacing goes after 10 seconds.
				 */
				const takeover = `${path}.takeover`;
				const replaceStale = Effect.gen(function* () {
					const made = yield* fs.makeDirectory(takeover).pipe(
						Effect.as(true),
						Effect.catchIf(exists, () => Effect.succeed(false)),
					);
					if (!made) {
						const left = yield* fs.stat(takeover).pipe(Effect.option);
						const age = Option.flatMap(left, (info) => info.mtime);
						if (Option.isSome(age) && (yield* Clock.currentTimeMillis) - age.value.getTime() > 10_000)
							yield* fs.remove(takeover, { recursive: true });
						return yield* taken(0);
					}
					yield* Effect.gen(function* () {
						const holder = yield* read;
						if (holder && alive(holder.pid)) return yield* taken(holder.pid);
						yield* fs.remove(path, { force: true });
						yield* create;
					}).pipe(Effect.ensuring(Effect.ignore(fs.remove(takeover, { recursive: true }))));
				});
				const acquire = Effect.gen(function* () {
					yield* fs.makeDirectory(store, { recursive: true });
					const created = yield* create.pipe(
						Effect.as(true),
						Effect.catchIf(exists, () => Effect.succeed(false)),
					);
					if (created) return;
					const holder = yield* read;
					if (holder && alive(holder.pid)) return yield* taken(holder.pid);
					// Stale: its service is gone (or the file isn't a registration), or it went just now.
					yield* replaceStale;
				}).pipe(
					Effect.catchIf(
						(error) => error._tag !== "AlreadyRunning",
						() => Effect.flatMap(read, (holder) => Effect.fail(taken(holder?.pid ?? 0))),
					),
				);
				const release = Effect.flatMap(read, (holder) =>
					holder?.pid === process.pid ? Effect.ignore(fs.remove(path)) : Effect.void,
				);

				// A service that's shutting down still holds the file for a moment after its socket closes: wait it out.
				yield* Effect.acquireRelease(
					acquire.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 })),
					() => release,
				);
				return Registration.of({
					publish: (where) =>
						Effect.gen(function* () {
							const temp = `${path}.${process.pid}`;
							yield* fs.writeFileString(temp, encode({ ...own, ...where }));
							yield* fs.rename(temp, path);
						}).pipe(Effect.orDie),
				});
			}),
		);
	}
}
