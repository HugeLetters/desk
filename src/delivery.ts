/**
 * Delivery: takes every outbox message to its session, once. A message whose session no connected OpenCode knows
 * stays in the outbox ("answered, not delivered") and goes out when a server that knows it attaches; one whose
 * delivery failed is tried again then, or after `retry`.
 *
 * Once: the message id is fixed before the first try and OpenCode admits an id once, so sending again after a crash
 * between "sent" and "marked delivered" doesn't deliver twice.
 */
import { pathToFileURL } from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Desk } from "./desk";
import { OpenCode } from "./opencode";
import { messages } from "./outbox";
import { Store } from "./store";

export const layer = (retry: Duration.Input = "30 seconds") =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const desk = yield* Desk;
			const opencode = yield* OpenCode;
			const store = yield* Store;

			const flush = Effect.gen(function* () {
				for (const message of messages(yield* desk.entries)) {
					const files = message.files.map(({ file, name }) => ({ uri: pathToFileURL(`${store.root}/${file}`).href, name }));
					const sent = yield* opencode.prompt({ sessionID: message.session, id: message.id, text: message.text, delivery: message.delivery, files });
					if (sent) yield* desk.delivered(message.id);
				}
			}).pipe(Effect.catch((error) => Effect.logWarning(error.message)));

			// One flush at a time; triggers that pile up meanwhile only need one more.
			yield* Stream.mergeAll([Stream.map(desk.changes, () => undefined), Stream.map(opencode.attached, () => undefined), Stream.tick(Duration.fromInputUnsafe(retry))], { concurrency: "unbounded" }).pipe(
				Stream.debounce("20 millis"),
				Stream.runForEach(() => flush),
				Effect.forkScoped,
			);
		}),
	);
