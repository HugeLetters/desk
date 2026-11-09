import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { Clients } from "../src/service/clients";

const run = <A>(effect: Effect.Effect<A, never, Clients | Scope.Scope>) =>
	Effect.runPromise(Effect.scoped(Effect.provide(effect, Clients.layer("50 millis"))));
/** Whether `idle` has completed by now. */
const idleNow = Effect.flatMap(Clients, (clients) => Effect.map(Effect.timeoutOption(clients.idle, 0), Option.isSome));

test("idle once there have been no clients for `after`, counting from the start", async () => {
	expect(await run(Effect.andThen(Effect.sleep("100 millis"), idleNow))).toBe(true);
});

test("a client holds idle off for as long as it stays; its going starts the wait over", async () => {
	const seen = await run(
		Effect.gen(function* () {
			const clients = yield* Clients;
			yield* Effect.forkScoped(Effect.scoped(Effect.andThen(clients.hold, Effect.sleep("200 millis"))));
			yield* Effect.sleep("150 millis");
			const held = yield* idleNow;
			yield* Effect.sleep("80 millis");
			const justGone = yield* idleNow;
			yield* Effect.sleep("100 millis");
			return { held, justGone, later: yield* idleNow, count: yield* clients.count };
		}),
	);
	expect(seen).toEqual({ held: false, justGone: false, later: true, count: 0 });
});

test("retiring ends it at once, clients or not", async () => {
	const done = await run(
		Effect.gen(function* () {
			const clients = yield* Clients;
			yield* Effect.forkScoped(Effect.scoped(Effect.andThen(clients.hold, Effect.never)));
			yield* Effect.sleep("10 millis");
			yield* clients.retire;
			return yield* idleNow;
		}),
	);
	expect(done).toBe(true);
});
