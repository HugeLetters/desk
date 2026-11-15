/**
 * The user's drafts, by entry, per desk: kept in the browser (IndexedDB, beside the attachments) until they're sent.
 * Each desk's are loaded when the page shows it, and saved on every change.
 */
import { type Accessor, batch, createEffect, createSignal, on } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { EntryId } from "../../src/model/entry";
import * as Database from "../database";

export type Texts = Partial<Record<string, string>>;

/** A desk's key in the database: its session, or empty for the list of desks. */
const keyOf = (desk: string | undefined) => desk ?? "";

const load = (key: string) =>
	Database.run((query) => query.from("drafts").select().equals(key)).then((rows) => rows[0]?.drafts ?? {});

const save = (key: string, drafts: Database.Drafts["drafts"]) =>
	Database.run((query) => query.from("drafts").upsert({ desk: key, drafts }));

export const createDrafts = (desk: Accessor<string | undefined>) => {
	const [drafts, setDrafts] = createStore<Texts>({});
	/** The desk whose drafts the store holds, once they're loaded: until then nothing's saved (it would overwrite them). */
	const [held, setHeld] = createSignal<string>();
	let loading: Promise<void> = Promise.resolve();
	/** Saves, one after another, so the last one wins. */
	let saving: Promise<unknown> = Promise.resolve();

	createEffect(
		on(desk, (id) => {
			const key = keyOf(id);
			batch(() => {
				setHeld(undefined);
				setDrafts(reconcile({}));
			});

			// Unreadable, they start empty, and are still saved from here on.
			loading = load(key)
				.catch(() => ({}))
				.then((stored) => {
					if (keyOf(desk()) !== key) return;

					// Anything typed while they loaded stays.
					batch(() => {
						setDrafts(reconcile({ ...stored, ...unwrap(drafts) }));
						setHeld(key);
					});
				});
		}),
	);

	createEffect(() => {
		const key = held();
		if (key === undefined) return;

		// Reads every draft: any change saves them.
		const texts = JSON.stringify(drafts);
		saving = saving.then(() => save(key, JSON.parse(texts))).catch(() => {});
	});

	/** Done once this desk's drafts are loaded and every change so far is saved. */
	const settled = async () => {
		await loading;
		await saving;
	};

	/** The texts of the other desks' drafts, as saved. */
	const others = async () => {
		await settled();
		const key = held();
		const rows = await Database.run((query) => query.from("drafts").select());
		return rows.filter((row) => row.desk !== key).flatMap((row) => Object.values(row.drafts));
	};

	// Drafts are kept by the id of an entry on the desk, so their keys are entry ids.
	const pending = (): Array<{ entry: EntryId; text: string }> =>
		Object.entries(drafts).flatMap(([entry, text]) => (text?.trim() ? [{ entry: entry as EntryId, text }] : []));

	return { drafts, setDrafts, loaded: () => held() !== undefined, pending, others };
};

export interface Drafts extends ReturnType<typeof createDrafts> {}
