/**
 * Delivery: takes every outbox message to its session, once, through a connected plugin instance whose OpenCode knows
 * the session, while the session is in desk mode (`due`). A message no connected OpenCode knows, or whose session is out
 * of desk mode, stays in the outbox ("answered, not delivered") and goes out when a plugin instance connects or the
 * session turns desk mode on; one whose delivery failed is tried again then, or after `retry`. Each message is tried
 * on its own, all at once: one that fails or hangs doesn't hold up the others.
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
import type { MessageID } from "./entry";
import type { DeliveryFailed } from "./errors";
import { OpenCode } from "./opencode";
import { due, messages } from "./outbox";
import { Store } from "./store";
import { deliveryFailed } from "./wording";

export class Failures extends Context.Service<
	Failures,
	{
		/** Outbox (message id) → why its last delivery failed. */
		readonly current: Effect.Effect<ReadonlyMap<MessageID, DeliveryFailed>>;
		readonly changes: Stream.Stream<ReadonlyMap<MessageID, DeliveryFailed>>;
		readonly set: (outbox: MessageID, reason: DeliveryFailed | undefined) => Effect.Effect<void>;
		/** Forgets the failures of every message but these. */
		readonly retain: (outboxes: ReadonlySet<MessageID>) => Effect.Effect<void>;
	}
>()("desk/Failures") {
	static readonly layer = Layer.effect(
		Failures,
		Effect.gen(function* () {
			const failures = yield* SubscriptionRef.make<ReadonlyMap<MessageID, DeliveryFailed>>(new Map());
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
				retain: (outboxes) =>
					SubscriptionRef.update(failures, (all) =>
						[...all.keys()].every((outbox) => outboxes.has(outbox))
							? all
							: new Map([...all].filter(([outbox]) => outboxes.has(outbox))),
					),
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
				const entries = yield* desk.entries;
				const pending = messages(entries);
				// All at once: a plugin that hangs (until its call times out) doesn't hold up the other sessions.
				yield* Effect.forEach(
					due(entries, new Set(yield* opencode.inDeskMode)),
					(message) => {
						const files = message.files.map(({ file, name }) => ({
							uri: pathToFileURL(`${store.root}/${file}`).href,
							name,
						}));
						return opencode
							.prompt({
								sessionID: message.session,
								id: message.id,
								text: message.text,
								delivery: message.delivery,
								files,
							})
							.pipe(
								Effect.flatMap((sent) => (sent ? desk.delivered(message.id) : Effect.void)),
								Effect.andThen(failures.set(message.id, undefined)),
								Effect.catch((failed) =>
									Effect.andThen(Effect.logWarning(deliveryFailed(failed)), failures.set(message.id, failed)),
								),
							);
					},
					{ concurrency: "unbounded", discard: true },
				);
				// Messages that left the outbox (delivered, or their entry went) have nothing to report.
				yield* failures.retain(new Set(pending.map((message) => message.id)));
			});

			// One flush at a time; triggers that pile up meanwhile only need one more.
			yield* Stream.mergeAll(
				[
					Stream.map(desk.changes, () => undefined),
					Stream.map(opencode.attached, () => undefined),
					Stream.map(opencode.deskMode, () => undefined),
					Stream.tick(Duration.fromInputUnsafe(retry)),
				],
				{ concurrency: "unbounded" },
			).pipe(
				Stream.debounce("20 millis"),
				Stream.runForEach(() => flush),
				Effect.forkScoped,
			);
		}),
	);
