/**
 * Files attached to drafts, kept in the browser (IndexedDB, so they survive reloads) until their draft is sent. The
 * draft's Markdown names one `attachment:<id>`; sending uploads only those the text still references.
 */

import * as Effect from "effect/Effect";
import type { Attachment } from "../src/api/api";
import { referencedAttachments } from "../src/model/entry";
import * as Database from "./database";

export type Local = Database.Attachment;

/** `![name](attachment:<id>)` for images and video (rendered inline), `[name](attachment:<id>)` otherwise. */
export const link = (file: Local) =>
	`${/^(image|video)\//.test(file.type) ? "!" : ""}[${file.name.replace(/[[\]]/g, "")}](attachment:${file.id})`;

/** The attachment ids a draft's text references. */
export const referenced = referencedAttachments;

export const all = () => Database.run((query) => query.from("attachments").select());

export const save = (file: Local) => Database.run((query) => Effect.asVoid(query.from("attachments").upsert(file)));

export const remove = (ids: Iterable<string>) =>
	Database.run((query) =>
		Effect.forEach(ids, (id) => query.from("attachments").delete().equals(id), { discard: true }).pipe(
			query.withTransaction({ tables: ["attachments"], mode: "readwrite" }),
		),
	);

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
