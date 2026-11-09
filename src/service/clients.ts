/**
 * The service's clients: connected plugin instances and open pages. `idle` completes once there have been none for
 * `after` straight (counting from the start, too), or once the service retires; either way the service exits.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

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
				const count = yield* SubscriptionRef.make(0);
				const idle = yield* Deferred.make<void>();
				// Every change of the count starts the wait over; it ends only after `after` at none.
				yield* SubscriptionRef.changes(count).pipe(
					Stream.switchMap((now) => (now === 0 ? Stream.fromEffect(Effect.sleep(after)) : Stream.empty)),
					Stream.runHead,
					Effect.andThen(Deferred.succeed(idle, undefined)),
					Effect.forkScoped,
				);
				return Clients.of({
					hold: Effect.acquireRelease(
						SubscriptionRef.update(count, (now) => now + 1),
						() => SubscriptionRef.update(count, (now) => now - 1),
					),
					count: SubscriptionRef.get(count),
					idle: Deferred.await(idle),
					retire: Effect.asVoid(Deferred.succeed(idle, undefined)),
				});
			}),
		);
	}
}
