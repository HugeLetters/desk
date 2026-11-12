/**
 * The service's registration, `<store>/service.json`: the lock that keeps the store to one service, and what the
 * running service is (`Info`, `service-info.ts`), as OpenCode's own `service.json` is.
 *
 * A service creates the file exclusively when it starts. If it exists and names a live process, another service has
 * the store and this one leaves (`AlreadyRunning`); if that process is gone, the file is stale and replaced, by one
 * service at a time (`<store>/service.json.takeover`, a directory made exclusively). The file goes when the service
 * stops. A port, configured or not, doesn't decide anything: the page takes whichever port it can and writes it here.
 *
 * Taking it is a machine (`machine.ts`): `Creating` the file; `Checking` who has it when it exists; `Replacing` a dead
 * service's file while holding the takeover directory (for exactly as long as the state lasts); `Waiting` a moment
 * before trying again, since a service that's shutting down still holds the file for a moment after its socket closes;
 * and, for good, `Registered` or `Taken`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Unify from "effect/Unify";
import * as Machine from "../machine";
import { protocol } from "../protocol";
import * as ServiceInfo from "../service-info";

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

/** `attempt` counts from 0; `pid` is the holder last seen (0: none known). */
export type State = Data.TaggedEnum<{
	Creating: { readonly attempt: number };
	Checking: { readonly attempt: number };
	Replacing: { readonly attempt: number };
	Waiting: { readonly attempt: number; readonly pid: number };
	// biome-ignore lint/complexity/noBannedTypes: a TaggedEnum member without fields is `{}`.
	Registered: {};
	Taken: { readonly pid: number };
}>;
export const State = Data.taggedEnum<State>();

export type Event = Data.TaggedEnum<{
	/** The file is this service's. */
	// TODO main | just fucking create an Empty type and reuse and lint ignore once | by Evgenii Perminov at Thu, 12 Nov 2026 23:29:46 GMT
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Created: {};
	/** Creating it found one there. */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Exists: {};
	/** It names a live process. */
	Held: { readonly pid: number };
	/** It names a process that's gone, or isn't a registration. */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Stale: {};
	/** Another service is replacing it. */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Contended: {};
	/** Something else went wrong (the store can't be written, say). */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Failed: {};
	/** `Waiting` is over. */
	// biome-ignore lint/complexity/noBannedTypes: as above.
	Retry: {};
}>;
export const Event = Data.taggedEnum<Event>();

/** Tries before giving up: 100 ms apart, so about three seconds. */
export const attempts = 31;

/** Not this time: wait and try again, unless that was the last try. */
const later = (attempt: number, pid: number): State =>
	attempt + 1 >= attempts ? State.Taken({ pid }) : State.Waiting({ attempt, pid });

export const reconcile = (state: State, event: Event): State => {
	switch (state._tag) {
		case "Registered":
		case "Taken":
			return state;
		case "Waiting":
			return event._tag === "Retry" ? State.Creating({ attempt: state.attempt + 1 }) : state;
		case "Creating":
		case "Checking":
		case "Replacing":
			switch (event._tag) {
				case "Created":
					return state._tag === "Checking" ? state : State.Registered();
				case "Exists":
					return state._tag === "Creating" ? State.Checking({ attempt: state.attempt }) : state;
				case "Stale":
					return state._tag === "Checking" ? State.Replacing({ attempt: state.attempt }) : state;
				case "Held":
					return later(state.attempt, event.pid);
				case "Contended":
				case "Failed":
					return later(state.attempt, 0);
				case "Retry":
					return state;
			}
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
		const own: ServiceInfo.Info = { pid: process.pid, protocol };
		return Layer.effect(
			Registration,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = (yield* ServiceInfo.files(store)).registration;
				/** The registration there now; undefined when there's none or it isn't one. */
				const read = Effect.map(ServiceInfo.read(store), Option.getOrUndefined);
				// Whole or not at all: written beside it, then linked into place (failing if it exists). Created empty and then
				// written, a reader in between would take the empty file for a dead service's, remove it and take the lock.
				const create = Effect.gen(function* () {
					const temp = `${path}.${process.pid}.new`;
					yield* fs.writeFileString(temp, yield* ServiceInfo.encode(own));
					yield* fs.link(temp, path).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp))));
				});
				const exists = (error: { readonly _tag: string; readonly reason?: { readonly _tag: string } }) =>
					error._tag === "PlatformError" && error.reason?._tag === "AlreadyExists";
				/**
				 * Replacing a dead service's file, one service at a time: whoever makes this directory. Only a service holding
				 * it removes the file, after reading it again: two removing at once, one could remove the other's fresh one,
				 * and both would hold the store. One left by a service that crashed while replacing goes after 10 seconds.
				 */
				const takeover = `${path}.takeover`;
				const replace = Effect.gen(function* () {
					const made = yield* fs.makeDirectory(takeover).pipe(
						Effect.as(true),
						Effect.catchIf(exists, () => Effect.succeed(false)),
					);
					if (!made) {
						const left = yield* fs.stat(takeover).pipe(Effect.option);
						const age = Option.flatMap(left, (info) => info.mtime);
						if (Option.isSome(age) && (yield* Clock.currentTimeMillis) - age.value.getTime() > 10_000)
							yield* fs.remove(takeover, { recursive: true });
						return Event.Contended();
					}
					yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(takeover, { recursive: true })));
					const holder = yield* read;
					if (holder && alive(holder.pid)) return Event.Held({ pid: holder.pid });
					yield* fs.remove(path, { force: true });
					yield* create;
					return Event.Created();
				}).pipe(Effect.scoped);

				/** What being in `state` comes to: what happened (nothing, for good, once it's settled). */
				const step = flow(
					(state: State) => {
						switch (state._tag) {
							case "Creating":
								return Effect.andThen(fs.makeDirectory(store, { recursive: true }), create).pipe(
									Effect.as(Event.Created()),
									Effect.catchIf(exists, () => Effect.succeed(Event.Exists())),
								);
							case "Checking":
								return Effect.map(read, (holder) =>
									holder && alive(holder.pid) ? Event.Held({ pid: holder.pid }) : Event.Stale(),
								);
							case "Replacing":
								return replace;
							case "Waiting":
								return Effect.as(Effect.sleep("100 millis"), Event.Retry());
							case "Registered":
							case "Taken":
								return Effect.never;
						}
					},
					(v) => Unify.unify(v),
				);

				const machine: Machine.Machine<State, Event, FileSystem.FileSystem | Path.Path> = {
					initial: State.Creating({ attempt: 0 }),
					reconcile,
					run: (state, emit) =>
						Effect.flatMap(
							Effect.orElseSucceed(step(state), () => Event.Failed()),
							emit,
						),
				};
				const actor = yield* Machine.start(machine);
				const taken = yield* actor.when((state) =>
					state._tag === "Registered"
						? Option.some(Option.none<number>())
						: state._tag === "Taken"
							? Option.some(Option.some(state.pid))
							: Option.none(),
				);
				if (Option.isSome(taken)) return yield* new AlreadyRunning({ path, pid: taken.value });
				yield* Effect.addFinalizer(() =>
					Effect.flatMap(read, (holder) =>
						holder?.pid === process.pid ? Effect.ignore(fs.remove(path)) : Effect.void,
					),
				);
				return Registration.of({
					publish: (where) =>
						Effect.gen(function* () {
							const temp = `${path}.${process.pid}`;
							yield* fs.writeFileString(temp, yield* ServiceInfo.encode({ ...own, ...where }));
							yield* fs.rename(temp, path);
						}).pipe(Effect.orDie),
				});
			}),
		);
	}
}
