/**
 * The service's registration, `<store>/service.json`: the lock that keeps the store to one service, and what the
 * running service is (`{ pid, protocol, url, socket }`), as OpenCode's own `service.json` is.
 *
 * A service creates the file exclusively when it starts. If it exists and names a live process, another service has
 * the store and this one leaves (`AlreadyRunning`); if that process is gone, the file is stale and replaced. The file
 * goes when the service stops. A port, configured or not, doesn't decide anything: the page takes whichever port it
 * can and writes it here.
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { protocol } from "../protocol";

export class AlreadyRunning extends Data.TaggedError("AlreadyRunning")<{ readonly path: string; readonly pid: number }> {}

export interface Info {
	readonly pid: number;
	readonly protocol: string;
	readonly url?: string | undefined;
	readonly socket?: string | undefined;
}

/** Reads a registration; undefined when there's none or it can't be read. */
export const read = (store: string): Info | undefined => {
	try {
		return JSON.parse(readFileSync(join(store, "service.json"), "utf8")) as Info;
	} catch {
		return undefined;
	}
};

/** Removes the registration if it's this process's: for an exit that skips the layer's own cleanup. */
export const releaseNow = (store: string) => {
	if (read(store)?.pid === process.pid) rmSync(join(store, "service.json"), { force: true });
};

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
		const path = join(store, "service.json");
		const own: Info = { pid: process.pid, protocol };
		const create = () => {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, JSON.stringify(own));
			} finally {
				closeSync(fd);
			}
		};
		const acquire = Effect.try({
			try: () => {
				try {
					return create();
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				const holder = read(store);
				if (holder && alive(holder.pid)) throw new AlreadyRunning({ path, pid: holder.pid });
				// Stale: its service is gone (or the file is unreadable). Another service may be replacing it right now:
				// only one of the two creates it, and one that removed the other's fresh file finds out reading it back.
				rmSync(path, { force: true });
				create();
				const kept = read(store);
				if (kept?.pid !== process.pid) throw new AlreadyRunning({ path, pid: kept?.pid ?? 0 });
			},
			catch: (error) => (error instanceof AlreadyRunning ? error : new AlreadyRunning({ path, pid: read(store)?.pid ?? 0 })),
		});
		const release = Effect.sync(() => {
			if (read(store)?.pid === process.pid) rmSync(path, { force: true });
		});
		return Layer.effect(
			this,
			Effect.gen(function* () {
				// A service that's shutting down still holds the file for a moment after its socket closes: wait it out.
				yield* Effect.acquireRelease(acquire.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 })), () => release);
				return Registration.of({
					publish: (where) =>
						Effect.sync(() => {
							const temp = `${path}.${process.pid}`;
							writeFileSync(temp, JSON.stringify({ ...own, ...where }));
							renameSync(temp, path);
						}),
				});
			}),
		);
	}
}
