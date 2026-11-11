/**
 * State machines, run as actors. A machine is a closed set of states and two functions:
 *
 * - `reconcile(state, event) → state`: pure and total, so every (state, event) pair has an answer and the rules can be
 *   property-tested on their own. Returning an equal state (`Equal.equals`) means nothing happened.
 * - `run(state)`: what being in `state` requires (a timer, a send, a held file). It's started on entering the state and
 *   interrupted on leaving it, so nothing a state started outlives it. It reports back only through `emit`, and what it
 *   emits once its state is left (a timer that fired as the state changed) is dropped.
 * - `key(state)`, optional: states with the same key (`Equal.equals`) share one `run`, started in the first of them,
 *   for a resource that lasts through several (one connection, connecting and then live). By default, the state.
 *
 * The actor is one fiber with a mailbox: it alone holds the state, and takes events one at a time. Others `send` it
 * events and watch its state (`changes`, `when`); nobody sets it.
 */
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface Machine<S, E, R = never> {
	readonly initial: S;
	readonly reconcile: (state: S, event: E) => S;
	readonly run: (state: S, emit: (event: E) => Effect.Effect<void>) => Effect.Effect<void, never, R>;
	readonly key?: (state: S) => unknown;
}

export interface Actor<S, E> {
	readonly send: (event: E) => Effect.Effect<void>;
	readonly state: Effect.Effect<S>;
	/** The state now, then every new one. */
	readonly changes: Stream.Stream<S>;
	/** The first state, now or later, that `pick` takes. */
	readonly when: <A>(pick: (state: S) => Option.Option<A>) => Effect.Effect<A>;
}

/** An event, and where it came from: `undefined` from `send`, else the number of the `run` that emitted it. */
interface Message<E> {
	readonly event: E;
	readonly from: number | undefined;
}

/** Runs `machine` from its initial state until the scope closes, which interrupts the current state's `run`. */
export const start = <S, E, R>(machine: Machine<S, E, R>): Effect.Effect<Actor<S, E>, never, R | Scope.Scope> =>
	Effect.gen(function* () {
		const mailbox = yield* Queue.unbounded<Message<E>>();
		const states = yield* SubscriptionRef.make(machine.initial);

		const key = machine.key ?? ((state: S) => state);

		/** Events, for the `n`th run, until one changes `state`'s key: the state then. */
		const next = (state: S, n: number): Effect.Effect<S> =>
			Effect.flatMap(Queue.take(mailbox), ({ event, from }) => {
				if (from !== undefined && from !== n) return next(state, n);
				const after = machine.reconcile(state, event);
				if (Equal.equals(after, state)) return next(state, n);
				if (!Equal.equals(key(after), key(state))) return Effect.succeed(after);
				return Effect.andThen(SubscriptionRef.set(states, after), next(after, n));
			});
		/** The `n`th run, from `state` until an event changes the key; then the next, for good. */
		const enter = (state: S, n: number): Effect.Effect<never, never, R> =>
			Effect.andThen(SubscriptionRef.set(states, state), () =>
				Effect.raceFirst(
					Effect.andThen(
						machine.run(state, (event) => Effect.asVoid(Queue.offer(mailbox, { event, from: n }))),
						Effect.never,
					),
					next(state, n),
				).pipe(Effect.flatMap((after) => enter(after, n + 1))),
			);

		yield* Effect.forkScoped(enter(machine.initial, 0));
		const actor: Actor<S, E> = {
			send: (event) => Effect.asVoid(Queue.offer(mailbox, { event, from: undefined })),
			state: SubscriptionRef.get(states),
			changes: SubscriptionRef.changes(states),
			when: (pick) =>
				SubscriptionRef.changes(states).pipe(
					Stream.map(pick),
					Stream.filter(Option.isSome),
					Stream.runHead,
					// `changes` never ends: without a head, it was interrupted.
					Effect.flatMap((head) =>
						Option.match(Option.flatten(head), { onNone: () => Effect.never, onSome: Effect.succeed }),
					),
				),
		};
		return actor;
	});
