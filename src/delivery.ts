/**
 * Delivery: takes every outbox message to its session, once, through a connected plugin instance whose OpenCode knows
 * the session. A message no connected OpenCode knows stays in the outbox ("answered, not delivered") and goes out when
 * a plugin instance connects; one whose delivery failed is tried again then, or after `retry`. Each message is tried
 * on its own: one that fails doesn't hold up the others.
 *
 * Once: the message id is fixed before the first try and OpenCode admits an id once, so sending again after a crash
 * between "sent" and "marked delivered" doesn't deliver twice.
 *
 * Why the last try of a message failed, when it did (not merely "no OpenCode knows the session"), is kept in memory
 * (`Failures`) for the page to show.
 */
import { pathToFileURL } from "node:url";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Desk } from "./desk";
import { OpenCode } from "./opencode";
import { messages } from "./outbox";
import { Store } from "./store";

export class Failures extends Context.Service<
	Failures,
	{
		/** Outbox (message id) → why its last delivery failed. */
		readonly current: Effect.Effect<ReadonlyMap<string, string>>;
		readonly changes: Stream.Stream<ReadonlyMap<string, string>>;
		readonly set: (outbox: string, reason: string | undefined) => Effect.Effect<void>;
	}
>()("desk/Failures") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const failures = yield* SubscriptionRef.make<ReadonlyMap<string, string>>(new Map());
			return Failures.of({
				current: SubscriptionRef.get(failures),
				changes: SubscriptionRef.changes(failures),
				set: (outbox, reason) =>
					SubscriptionRef.update(failures, (all) => {
						if (all.get(outbox) === reason) return all;
						const next = new Map(all);
						if (reason === undefined) next.delete(outbox);
						else next.set(outbox, reason);
						return next;
					}),
			});
		}),
	);
}

export const layer = (retry: Duration.Input = "30 seconds") =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const desk = yield* Desk;
			const opencode = yield* OpenCode;
			const store = yield* Store;
			const failures = yield* Failures;

			const flush = Effect.gen(function* () {
				const pending = messages(yield* desk.entries);
				for (const message of pending) {
					const files = message.files.map(({ file, name }) => ({ uri: pathToFileURL(`${store.root}/${file}`).href, name }));
					yield* opencode.prompt({ sessionID: message.session, id: message.id, text: message.text, delivery: message.delivery, files }).pipe(
						Effect.flatMap((sent) => (sent ? desk.delivered(message.id) : Effect.void)),
						Effect.andThen(failures.set(message.id, undefined)),
						Effect.catch((error) => Effect.andThen(Effect.logWarning(error.message), failures.set(message.id, error.message))),
					);
				}
				// Messages that left the outbox (delivered, or their entry went) have nothing to report.
				for (const outbox of (yield* failures.current).keys()) if (!pending.some((message) => message.id === outbox)) yield* failures.set(outbox, undefined);
			});

			// One flush at a time; triggers that pile up meanwhile only need one more.
			yield* Stream.mergeAll([Stream.map(desk.changes, () => undefined), Stream.map(opencode.attached, () => undefined), Stream.tick(Duration.fromInputUnsafe(retry))], { concurrency: "unbounded" }).pipe(
				Stream.debounce("20 millis"),
				Stream.runForEach(() => flush),
				Effect.forkScoped,
			);
		}),
	);
