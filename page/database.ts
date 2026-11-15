/**
 * The page's IndexedDB (`desk`), through `@effect/platform-browser`: the drafts' attachments (version 1) and the
 * drafts (version 2), both kept until they're sent.
 */
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import * as IndexedDbDatabase from "@effect/platform-browser/IndexedDbDatabase";
import * as IndexedDbTable from "@effect/platform-browser/IndexedDbTable";
import * as IndexedDbVersion from "@effect/platform-browser/IndexedDbVersion";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import type { Identity } from "../src/shared/type";

/** A file attached to a draft. */
export const Attachment = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	blob: Schema.instanceOf(Blob),
});
export interface Attachment extends Identity<typeof Attachment.Type> {}

/** A desk's drafts, by entry id; `desk` is its session (empty for the list of desks). */
export const Drafts = Schema.Struct({ desk: Schema.String, drafts: Schema.Record(Schema.String, Schema.String) });
export interface Drafts extends Identity<typeof Drafts.Type> {}

class AttachmentsTable extends IndexedDbTable.make({ name: "attachments", schema: Attachment, keyPath: "id" }) {}
class DraftsTable extends IndexedDbTable.make({ name: "drafts", schema: Drafts, keyPath: "desk" }) {}

class Version1 extends IndexedDbVersion.make(AttachmentsTable) {}
class Version2 extends IndexedDbVersion.make(AttachmentsTable, DraftsTable) {}

const Database = IndexedDbDatabase.make(Version1, (query) => query.createObjectStore("attachments")).add(
	Version2,
	(_, query) => query.createObjectStore("drafts"),
);

/** Opened (and upgraded) on first use, for as long as the page is open. */
const runtime = ManagedRuntime.make(Database.layer("desk").pipe(Layer.provide(IndexedDb.layerWindow)));

/** Runs `f` on the database; rejects with what failed. */
export const run = <A, E>(f: (query: Effect.Success<typeof Database.getQueryBuilder>) => Effect.Effect<A, E>) =>
	runtime.runPromise(Effect.flatMap(Database.getQueryBuilder, f));
