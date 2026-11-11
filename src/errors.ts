/**
 * What the desk refuses, and why a delivery failed, as data: each with the facts its wording needs. The service sends
 * them as they are; the page and the plugin word them (`wording.ts`), as a client words an HTTP status.
 */
import * as Schema from "effect/Schema";
import { EntryId, Party } from "./entry";

export class NoSuchEntry extends Schema.TaggedError<NoSuchEntry>()("NoSuchEntry", { id: Schema.String }) {}
/** An entry's parent never changes once set. */
export class HasParent extends Schema.TaggedError<HasParent>()("HasParent", { id: EntryId, parent: EntryId }) {}
/** Adopting `id` under `parent` would put it in its own subtree. */
export class WouldCycle extends Schema.TaggedError<WouldCycle>()("WouldCycle", { id: EntryId, parent: EntryId }) {}
/** Only the answerer answers: `by` asked it. */
export class NotTheAnswerer extends Schema.TaggedError<NotTheAnswerer>()("NotTheAnswerer", {
	id: EntryId,
	by: Party,
}) {}
/** Only the asker resolves. */
export class NotTheAsker extends Schema.TaggedError<NotTheAsker>()("NotTheAsker", { id: EntryId, asker: Party }) {}
export class AlreadyResolved extends Schema.TaggedError<AlreadyResolved>()("AlreadyResolved", { id: EntryId }) {}
/** The user's text on it hasn't reached the session yet. */
export class Undelivered extends Schema.TaggedError<Undelivered>()("Undelivered", { id: EntryId }) {}
/** Unresolved entries below it. */
export class OpenBelow extends Schema.TaggedError<OpenBelow>()("OpenBelow", {
	id: EntryId,
	below: Schema.Array(EntryId),
}) {}
export class EmptyText extends Schema.TaggedError<EmptyText>()("EmptyText", { id: EntryId }) {}
/** The draft's text points at an attachment the draft doesn't carry. */
export class MissingAttachment extends Schema.TaggedError<MissingAttachment>()("MissingAttachment", {
	id: EntryId,
	attachment: Schema.String,
}) {}
/** Nothing on it waits to be delivered (it may have just gone out). */
export class NothingUndelivered extends Schema.TaggedError<NothingUndelivered>()("NothingUndelivered", {
	id: EntryId,
}) {}

/** The entry is on another session's desk: a thread never spans two desks. */
export class OtherDesk extends Schema.TaggedError<OtherDesk>()("OtherDesk", { id: EntryId }) {}
/** No entries belong to that session: there's no desk to claim. */
export class NoSuchDesk extends Schema.TaggedError<NoSuchDesk>()("NoSuchDesk", { session: Schema.String }) {}
/** That session is in desk mode: its desk can't be taken from under it. */
export class DeskInUse extends Schema.TaggedError<DeskInUse>()("DeskInUse", { session: Schema.String }) {}

export const Refusal = Schema.Union([
	NoSuchEntry,
	HasParent,
	WouldCycle,
	NotTheAnswerer,
	NotTheAsker,
	AlreadyResolved,
	Undelivered,
	OpenBelow,
	EmptyText,
	MissingAttachment,
	NothingUndelivered,
	OtherDesk,
	NoSuchDesk,
	DeskInUse,
]);
export type Refusal = typeof Refusal.Type;

/** OpenCode didn't take a message: what it (or the plugin carrying it) said. */
export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
	session: Schema.String,
	cause: Schema.String,
}) {}
