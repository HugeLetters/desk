/**
 * Files attached to drafts, kept in the browser (IndexedDB, so they survive reloads) until their draft is sent. The
 * draft's Markdown names one `attachment:<id>`; sending uploads only those the text still references.
 */

import type { Attachment } from "../src/api/page-api";
import { referencedAttachments } from "../src/model/entry";

export interface Local {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly blob: Blob;
}

/** `![name](attachment:<id>)` for images and video (rendered inline), `[name](attachment:<id>)` otherwise. */
export const link = (file: Local) =>
	`${/^(image|video)\//.test(file.type) ? "!" : ""}[${file.name.replace(/[[\]]/g, "")}](attachment:${file.id})`;

/** The attachment ids a draft's text references. */
export const referenced = referencedAttachments;

const database = new Promise<IDBDatabase>((resolve, reject) => {
	const request = indexedDB.open("desk", 1);
	request.onupgradeneeded = () => request.result.createObjectStore("attachments", { keyPath: "id" });
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

async function transact<A>(
	mode: IDBTransactionMode,
	f: (store: IDBObjectStore) => IDBRequest<A> | undefined,
): Promise<A | undefined> {
	const transaction = (await database).transaction("attachments", mode);
	const request = f(transaction.objectStore("attachments"));
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve(request?.result);
		transaction.onerror = () => reject(transaction.error);
	});
}

export const all = async () => (await transact<Array<Local>>("readonly", (store) => store.getAll())) ?? [];
export const save = (file: Local) =>
	transact("readwrite", (store) => {
		store.put(file);
		return undefined;
	});
export const remove = (ids: Iterable<string>) =>
	transact("readwrite", (store) => {
		for (const id of ids) store.delete(id);
		return undefined;
	});

/** The files a draft's text references, ready to send. Ids it can't find are left to the desk to refuse. */
export async function outgoing(text: string, files: (id: string) => Local | undefined): Promise<Array<Attachment>> {
	return Promise.all(
		[...referenced(text)].flatMap((id) => {
			const file = files(id);
			if (!file) return [];
			return [file.blob.bytes().then((data) => ({ id, name: file.name, data }))];
		}),
	);
}
