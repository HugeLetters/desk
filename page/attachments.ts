/**
 * Files attached to drafts, kept in the browser (IndexedDB, so they survive reloads) until their draft is sent. The
 * draft's Markdown names one `attachment:<id>`; sending uploads only those the text still references.
 */
import type { Attachment } from "../src/page-api";

export interface Local {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly blob: Blob;
}

/** `![name](attachment:<id>)` for images and video (rendered inline), `[name](attachment:<id>)` otherwise. */
export const link = (file: Local) => `${/^(image|video)\//.test(file.type) ? "!" : ""}[${file.name.replace(/[[\]]/g, "")}](attachment:${file.id})`;

/** The attachment ids a draft's text references. */
export const referenced = (text: string) => new Set([...text.matchAll(/\]\(attachment:([0-9a-f-]{36})\)/g)].map(([, id]) => id!));

const database = new Promise<IDBDatabase>((resolve, reject) => {
	const request = indexedDB.open("desk", 1);
	request.onupgradeneeded = () => request.result.createObjectStore("attachments", { keyPath: "id" });
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

async function transact<A>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => IDBRequest<A> | void): Promise<A | undefined> {
	const transaction = (await database).transaction("attachments", mode);
	const request = f(transaction.objectStore("attachments"));
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve(request?.result);
		transaction.onerror = () => reject(transaction.error);
	});
}

export const all = async () => (await transact<Array<Local>>("readonly", (store) => store.getAll())) ?? [];
export const save = (file: Local) => transact("readwrite", (store) => void store.put(file));
export const remove = (ids: Iterable<string>) => transact("readwrite", (store) => void [...ids].forEach((id) => store.delete(id)));

/** The files a draft's text references, ready to send (base64). Ids it can't find are left to the desk to refuse. */
export async function outgoing(text: string, files: (id: string) => Local | undefined): Promise<Array<Attachment>> {
	return Promise.all(
		[...referenced(text)].flatMap((id) => {
			const file = files(id);
			if (!file) return [];
			return [
				file.blob.arrayBuffer().then((buffer) => {
					const bytes = new Uint8Array(buffer);
					let binary = "";
					for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
					return { id, name: file.name, data: btoa(binary) };
				}),
			];
		}),
	);
}
