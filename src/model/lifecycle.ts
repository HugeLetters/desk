/**
 * What can happen to one entry: `reconcile(entry, event)`, the entry after, or why the event is refused. Pure, so the
 * rules are one table and property-tested on their own (`tests/machines.test.ts`).
 *
 * `status` only goes forward (`open → answered → resolved`, or straight to `resolved`; resolving again changes
 * nothing); `pending` (the user's text on
 * its way to the session) is set only by the user's answer and cleared only by its delivery or the user discarding it;
 * `parent` is set once. What takes the other entries to decide (a cycle, what's open below, which desk a parent is on)
 * is the desk's (`desk.ts`), and comes in on the event.
 *
 * The desk has no actor for entries: the files are the state, and each change reads them, reconciles and writes, one
 * at a time.
 */
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import type { Empty } from "../shared/empty";
import type { Entry, EntryId, Party, Pending, Priority, SessionID } from "./entry";
import {
	AlreadyResolved,
	EmptyText,
	HasParent,
	NothingUndelivered,
	NotTheAnswerer,
	NotTheAsker,
	OpenBelow,
	type Refusal,
	Undelivered,
} from "./errors";

export type Event = Data.TaggedEnum<{
	/** `by` answers with `text`; the user's answer goes out as `pending` (an agent's leaves what's pending as it is). */
	Answer: { readonly by: Party; readonly text: string; readonly pending?: Pending | undefined };
	/** Its asker resolves it; `openBelow`: its unresolved follow-ups, all the way down. */
	Resolve: { readonly by: Party; readonly openBelow: ReadonlyArray<EntryId> };
	/** Its pending text reached the session. */
	Delivered: Empty;
	/** The user gives up on delivering its pending text. */
	Discard: Empty;
	/** Filed under `parent` (on its desk, not in its own subtree: the desk checked). */
	Adopt: { readonly parent: EntryId };
	Prioritize: { readonly priority: Priority };
	/** Another session takes its desk over. */
	Claim: { readonly session: SessionID };
}>;
export const Event = Data.taggedEnum<Event>();

const ok = Result.succeed<Entry>;

export const reconcile = (entry: Entry, event: Event): Result.Result<Entry, Refusal> => {
	const { id } = entry;
	switch (event._tag) {
		case "Answer":
			if (entry.asker === event.by) return Result.fail(new NotTheAnswerer({ id, by: event.by }));
			if (entry.status === "resolved") return Result.fail(new AlreadyResolved({ id }));
			// An answer says something, whoever gives it: blank text is no answer.
			if (!event.text.trim()) return Result.fail(new EmptyText({ id }));
			return ok({ ...entry, answer: event.text, status: "answered", pending: event.pending ?? entry.pending });
		case "Resolve":
			if (entry.asker !== event.by) return Result.fail(new NotTheAsker({ id, asker: entry.asker }));
			if (entry.pending !== null) return Result.fail(new Undelivered({ id }));
			if (event.openBelow.length > 0) return Result.fail(new OpenBelow({ id, below: event.openBelow }));
			return ok({ ...entry, status: "resolved" });
		case "Delivered":
			return ok({ ...entry, pending: null });
		case "Discard":
			return entry.pending === null ? Result.fail(new NothingUndelivered({ id })) : ok({ ...entry, pending: null });
		case "Adopt":
			return entry.parent !== null
				? Result.fail(new HasParent({ id, parent: entry.parent }))
				: ok({ ...entry, parent: event.parent });
		case "Prioritize":
			return ok({ ...entry, priority: event.priority });
		case "Claim":
			return ok({ ...entry, session: event.session });
	}
};
