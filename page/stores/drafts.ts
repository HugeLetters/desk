/** The user's drafts, by entry, per desk: kept in the browser until they're sent. */
import { type Accessor, createEffect, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { EntryId } from "../../src/model/entry";

export type Texts = Partial<Record<string, string>>;

const prefix = "desk.drafts.";
const keyOf = (desk: string | undefined) => `${prefix}${desk ?? ""}`;
// TODO main | why not keep drafts in idb too to have 1 storage? dont worry about migrating existing drafts | by Evgenii Perminov at Sun, 15 Nov 2026 14:37:01 GMT
const load = (key: string): Texts => JSON.parse(localStorage.getItem(key) ?? "{}");

export const createDrafts = (desk: Accessor<string | undefined>) => {
	/** The current desk's drafts, saved under its key; another desk swaps them for its own. */
	let current = keyOf(desk());
	const [drafts, setDrafts] = createStore<Texts>(load(current));
	createEffect(() => localStorage.setItem(current, JSON.stringify(drafts)));
	createEffect(
		on(
			desk,
			(id) => {
				current = keyOf(id);
				setDrafts(reconcile(load(current)));
			},
			{ defer: true },
		),
	);

	/** The texts of the other desks' drafts, as saved. */
	const others = async () =>
		Object.keys(localStorage)
			.filter((key) => key.startsWith(prefix) && key !== current)
			.flatMap((key) => Object.values(load(key)));

	// Drafts are kept by the id of an entry on the desk, so their keys are entry ids.
	const pending = (): Array<{ entry: EntryId; text: string }> =>
		Object.entries(drafts).flatMap(([entry, text]) => (text?.trim() ? [{ entry: entry as EntryId, text }] : []));

	return { drafts, setDrafts, pending, others };
};

export interface Drafts extends ReturnType<typeof createDrafts> {}
