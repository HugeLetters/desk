/**
 * The service's clients: connected plugin instances and open pages. `idle` completes once there have been none for
 * `after` straight (counting from the start, too), which is when the service exits.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class Clients extends Context.Service<
	Clients,
	{
		/** One client, until the scope closes. */
		readonly hold: Effect.Effect<void, never, Scope.Scope>;
		readonly count: Effect.Effect<number>;
		readonly idle: Effect.Effect<void>;
	}
>()("desk/Clients") {
	static layer(after: Duration.Input) {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const idle = yield* Deferred.make<void>();
				const scope = yield* Effect.scope;
				let count = 0;
				let timer: Fiber.Fiber<void> | undefined;
				const arm = Effect.map(Effect.forkIn(Effect.andThen(Effect.sleep(after), Effect.asVoid(Deferred.succeed(idle, undefined))), scope), (fiber) => {
					timer = fiber;
				});
				const disarm = Effect.suspend(() => {
					const running = timer;
					timer = undefined;
					return running ? Fiber.interrupt(running) : Effect.void;
				});
				yield* arm;
				return Clients.of({
					hold: Effect.acquireRelease(
						Effect.suspend(() => (++count === 1 ? disarm : Effect.void)),
						() => Effect.suspend(() => (--count === 0 ? arm : Effect.void)),
					),
					count: Effect.sync(() => count),
					idle: Deferred.await(idle),
				});
			}),
		);
	}
}
