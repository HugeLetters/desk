/** The desk the route shows, as the service's `view` stream keeps it: its entries, the desks, who's in desk mode. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { type Accessor, createEffect, createMemo, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { View } from "../../src/api/api";
import { type Entry, waitingFor } from "../../src/model/entry";
import { deliveryFailed } from "../../src/model/wording";
import * as Rpc from "../rpc";

/** `onView`: each view of the desk, as it comes. */
export const createView = (desk: Accessor<string | undefined>, onView: (view: View) => void) => {
	const [state, setState] = createStore<{ view: View | null; online: boolean; letIn: boolean }>({
		view: null,
		online: true,
		letIn: true,
	});

	// One view at a time, of the desk the route shows.
	createEffect(
		on(desk, (id) => {
			const subscription = Rpc.runtime.runFork(
				Rpc.withClient((client) =>
					client.view({ session: id }).pipe(
						Stream.runForEach((view) =>
							Effect.sync(() => {
								// The previous desk's stream may still deliver one before it stops.
								if ((view.desk?.session ?? undefined) !== id) return;

								setState("online", true);
								setState("letIn", true);
								setState("view", reconcile(view, { key: "id", merge: true }));
								onView(view);
							}),
						),
					),
				).pipe(
					Effect.tapError(() =>
						Effect.andThen(
							Effect.sync(() => setState("online", false)),
							Effect.flatMap(Rpc.letIn, (letIn) => Effect.sync(() => setState("letIn", letIn))),
						),
					),
					Effect.retry(Schedule.spaced("1 second")),
				),
			);
			onCleanup(() => Rpc.runtime.runFork(Fiber.interrupt(subscription)));
		}),
	);

	/** The entries of the desk shown; none while the previous desk's view is still up. */
	const entries = () => (state.view && (state.view.desk?.session ?? undefined) === desk() ? state.view.entries : []);
	const mine = createMemo(() => waitingFor(entries(), "user"));
	const theirs = createMemo(() => waitingFor(entries(), "agent"));
	const byId = (id: string) => entries().find((entry) => entry.id === id);

	/** Whether the entry's session is out of desk mode: its text waits until the session turns it on. */
	const outOfDeskMode = (entry: Entry) => !state.view?.deskMode.includes(entry.session);

	/** Why the last try to deliver the entry's text failed, if it did. */
	const failure = (entry: Entry) => (entry.pending === null ? undefined : state.view?.failures[entry.pending.message]);

	/** Why the entry's text hasn't reached its session. */
	const undelivered = (entry: Entry) => {
		const failed = failure(entry);
		if (failed) {
			return `Your text hasn't reached the session: the last try failed (${deliveryFailed(failed)}). It's tried again on every change, when an OpenCode connects, and every 30 s.`;
		}

		return outOfDeskMode(entry)
			? "Your text hasn't reached the session yet: it isn't in desk mode, so it couldn't reply on the desk. It goes out when the session turns desk mode on."
			: "Your text hasn't reached the session yet: no connected OpenCode knows it. It goes out when one does.";
	};

	return { state, entries, mine, theirs, byId, outOfDeskMode, failure, undelivered };
};
