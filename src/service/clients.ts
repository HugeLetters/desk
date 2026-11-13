/**
 * The service's clients: connected plugin instances and open pages. `idle` completes once there have been none for
 * `after` straight (counting from the start, too), or once the service retires; either way the service exits.
 *
 * A machine (`machine.ts`): `Busy` while there are clients, `Quiet` while there are none (its timer runs while it
 * lasts, so a client that comes and goes starts the wait over), `Done` for good.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { Empty } from "../shared/empty";
import * as Machine from "../shared/machine";

export type State = Data.TaggedEnum<{
	Busy: { readonly clients: number };
	Quiet: Empty;
	Done: { readonly why: "idle" | "retired" };
}>;
export const State = Data.taggedEnum<State>();

export type Event = Data.TaggedEnum<{
	Joined: Empty;
	Left: Empty;
	/** `Quiet` lasted `after`. */
	Elapsed: Empty;
	/** A newer service replaces this one. */
	Retire: Empty;
}>;
export const Event = Data.taggedEnum<Event>();

export const reconcile = (state: State, event: Event): State => {
	if (state._tag === "Done") return state;
	switch (event._tag) {
		case "Retire":
			return State.Done({ why: "retired" });
		case "Joined":
			return State.Busy({ clients: state._tag === "Busy" ? state.clients + 1 : 1 });
		case "Left":
			if (state._tag !== "Busy") return state;
			return state.clients > 1 ? State.Busy({ clients: state.clients - 1 }) : State.Quiet();
		case "Elapsed":
			return state._tag === "Quiet" ? State.Done({ why: "idle" }) : state;
	}
};

export const machine = (after: Duration.Input): Machine.Machine<State, Event> => ({
	initial: State.Quiet(),
	reconcile,
	run: (state, emit) =>
		state._tag === "Quiet" ? Effect.andThen(Effect.sleep(after), emit(Event.Elapsed())) : Effect.void,
});

export class Clients extends Context.Service<
	Clients,
	{
		/** One client, until the scope closes. */
		readonly hold: Effect.Effect<void, never, Scope.Scope>;
		readonly count: Effect.Effect<number>;
		readonly idle: Effect.Effect<void>;
		/** Ends the service now: a newer one replaces it. */
		readonly retire: Effect.Effect<void>;
	}
>()("desk/Clients") {
	static layer(after: Duration.Input) {
		return Layer.effect(
			Clients,
			Effect.gen(function* () {
				const actor = yield* Machine.start(machine(after));
				return Clients.of({
					hold: Effect.acquireRelease(actor.send(Event.Joined()), () => actor.send(Event.Left())),
					count: Effect.map(actor.state, (state) => (state._tag === "Busy" ? state.clients : 0)),
					idle: actor.when((state) => (state._tag === "Done" ? Option.some(undefined) : Option.none())),
					retire: actor.send(Event.Retire()),
				});
			}),
		);
	}
}
