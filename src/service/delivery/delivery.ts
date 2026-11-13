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
 *
 * Each due message is a machine (`machine.ts`) of its own: `Sending`, then `Delivered`, or `Waiting` (no OpenCode knows
 * the session, or the try failed) until the retry timer or a plugin instance connecting sends it again. Which messages
 * have one follows the files and the sessions in desk mode: a message that's due gets its machine, one that leaves the
 * outbox or stops being due loses it.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { MessageID } from "../../model/entry";
import type { DeliveryFailed } from "../../model/errors";
import { deliveryFailed } from "../../model/wording";
import type { Empty } from "../../shared/empty";
import * as Machine from "../../shared/machine";
import { Desk } from "../desk";
import { OpenCode } from "../opencode/opencode";
import { Store } from "../storage/store";
import { due as dueMessages, messages } from "./outbox";

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

export type State = Data.TaggedEnum<{
	Sending: Empty;
	/** Not sent: `failure` says why, or is undefined when no connected OpenCode knows the session. */
	Waiting: { readonly failure: DeliveryFailed | undefined };
	Delivered: Empty;
}>;
export const State = Data.taggedEnum<State>();

export type Event = Data.TaggedEnum<{
	/** In, and marked delivered; or it left the outbox meanwhile, so there's nothing to send. */
	Delivered: Empty;
	Unknown: Empty;
	Failed: { readonly failure: DeliveryFailed };
	/** The retry timer, or a plugin instance connecting: try again. */
	Retry: Empty;
}>;
export const Event = Data.taggedEnum<Event>();

export const reconcile = (state: State, event: Event): State => {
	switch (state._tag) {
		case "Delivered":
			return state;
		case "Waiting":
			return event._tag === "Retry" ? State.Sending() : state;
		case "Sending":
			switch (event._tag) {
				case "Delivered":
					return State.Delivered();
				case "Unknown":
					return State.Waiting({ failure: undefined });
				case "Failed":
					return State.Waiting({ failure: event.failure });
				case "Retry":
					return state;
			}
	}
};

export const layer = (retry: Duration.Input = "30 seconds") =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const desk = yield* Desk;
			const opencode = yield* OpenCode;
			const store = yield* Store;
			const path = yield* Path.Path;
			const failures = yield* Failures;

			/** Sends the message with id `id` as the files have it now: what came of it. */
			const send = (id: MessageID) =>
				Effect.gen(function* () {
					const message = messages(yield* desk.entries).find((one) => one.id === id);
					if (message === undefined) return Event.Delivered();
					// A path below the store always makes a file URL.
					const files = yield* Effect.forEach(message.files, ({ file, name }) =>
						Effect.map(Effect.orDie(path.toFileUrl(path.join(store.root, file))), (url) => ({
							uri: url.href,
							name,
						})),
					);
					const sent = yield* opencode.prompt({
						sessionID: message.session,
						id: message.id,
						text: message.text,
						delivery: message.delivery,
						files,
					});
					if (!sent) return Event.Unknown();
					yield* desk.delivered(message.id);
					return Event.Delivered();
				}).pipe(
					Effect.catch((failure) => Effect.as(Effect.logWarning(deliveryFailed(failure)), Event.Failed({ failure }))),
				);

			const machine = (id: MessageID): Machine.Machine<State, Event> => ({
				initial: State.Sending(),
				reconcile,
				run: (state, emit) => {
					switch (state._tag) {
						case "Sending":
							return Effect.flatMap(send(id), emit);
						case "Waiting":
							// Why, for the page, while it waits; then again after `retry`, or once a plugin instance connects.
							return failures
								.set(id, state.failure)
								.pipe(
									Effect.andThen(Effect.race(Effect.sleep(retry), Stream.runHead(opencode.joined))),
									Effect.andThen(emit(Event.Retry())),
								);
						case "Delivered":
							return failures.set(id, undefined);
					}
				},
			});
			/** One message's machine, until it's delivered. */
			const deliver = (id: MessageID) =>
				Effect.scoped(
					Effect.flatMap(Machine.start(machine(id)), (actor) =>
						actor.when((state) => (state._tag === "Delivered" ? Option.some(undefined) : Option.none())),
					),
				);

			// The due messages, each with its machine; a message's machine goes when it's no longer due.
			const running = yield* FiberMap.make<MessageID>();
			yield* Stream.mergeAll(
				[Stream.map(desk.changes, () => undefined), Stream.map(opencode.deskMode, () => undefined)],
				{ concurrency: "unbounded" },
			).pipe(
				Stream.debounce("20 millis"),
				Stream.runForEach(() =>
					Effect.gen(function* () {
						const entries = yield* desk.entries;
						const due = new Set(dueMessages(entries, new Set(yield* opencode.inDeskMode)).map((message) => message.id));
						yield* Effect.forEach(due, (id) => FiberMap.run(running, id, deliver(id), { onlyIfMissing: true }), {
							discard: true,
						});
						yield* Effect.forEach(
							Array.from(running, ([id]) => id).filter((id) => !due.has(id)),
							(id) => FiberMap.remove(running, id),
							{ discard: true },
						);
						// Messages that left the outbox (delivered, or their entry went) have nothing to report.
						yield* failures.retain(new Set(messages(entries).map((message) => message.id)));
					}),
				),
				Effect.forkScoped,
			);
		}),
	);
