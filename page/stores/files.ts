/** The drafts' attachments, with object URLs for their previews; the files themselves wait in IndexedDB until sent. */
import { createStore } from "solid-js/store";
import type { Draft } from "../../src/api/api";
import type { EntryId } from "../../src/model/entry";
import * as Attachments from "../attachments";
import type { Local } from "../markdown";
import type { Drafts } from "./drafts";

export const createFiles = (drafts: Drafts) => {
	const [files, setFiles] = createStore<Partial<Record<string, Attachments.Local & { url: string }>>>({});

	const keep = (file: Attachments.Local) => setFiles(file.id, { ...file, url: URL.createObjectURL(file.blob) });

	/**
	 * Lets go of the attachments no draft references anymore: those just sent, those whose draft went, and links deleted
	 * from the text. Other desks' drafts count too: their files share the browser's store.
	 */
	const prune = async () => {
		const others = await drafts.others();
		const texts = [...Object.values(drafts.drafts), ...others];
		const used = new Set(texts.flatMap((text) => [...Attachments.referenced(text ?? "")]));
		const unused = Object.keys(files).filter((id) => !used.has(id));
		for (const id of unused) {
			const file = files[id];
			if (file) URL.revokeObjectURL(file.url);
			setFiles(id, undefined);
		}

		return Attachments.remove(unused);
	};

	/** Done once the stored files are kept (and the unused ones pruned). */
	const loaded = Attachments.all()
		.then((stored) => {
			for (const file of stored) keep(file);
			return prune();
		})
		.catch(() => {});

	const local: Local = (id) => files[id];

	/** A draft as sent: its text and the attachments it still references. */
	const outgoing = async (draft: { entry: EntryId; text: string }): Promise<Draft> => ({
		...draft,
		files: await Attachments.outgoing(draft.text, (id) => files[id]),
	});

	return { keep, prune, loaded, local, outgoing };
};
