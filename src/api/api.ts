/**
 * The desk's API: one RPC group (`effect/rpc`), `DeskApi`, which the service serves and both of its kinds of client
 * call, checked against these schemas on both sides: the page (the user's desk) and the plugin instances (the agents'
 * tools, and the service's way into OpenCode). What the desk refuses comes back as a typed `Refusal`, worded by the
 * client (`wording.ts`). Its version is a hash of its code (`protocol.ts`).
 *
 * The caller is named in each request whose rules depend on who's calling (`by`): an agent, in its (top-level) session
 * and the directory that session works in, or the user. It's data, not a credential: everything runs locally, as the
 * user. Requests about a desk or an entry name that (a `session`, an `id`); the user's drafts (`submit`, `send`,
 * `discard`) are the user's by definition.
 *
 * A plugin instance says `hello` (the one request whose shape never changes, so two versions can always compare), then
 * holds `attach` open for as long as it's connected: the attachment lives exactly as long as that stream. The service
 * can't call a client, so its calls into the plugin's OpenCode (look a session up, prompt one) go out on that stream as
 * `ServiceCall`s, and the plugin answers each with `reply`; `modes` and `moved` keep the service up to date. The page
 * doesn't call those: it holds `view` open instead, and sends the user's drafts.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { Delivery, Entry, EntryId, MessageID, type Party, Priority, SessionID } from "../model/entry";
import { DeliveryFailed, Refusal } from "../model/errors";

/** Who's calling: an agent, in its top-level session (a subagent's is the one above it) and where that works, or the user. */
export const Caller = Schema.TaggedUnion({
	Agent: { session: SessionID, directory: Schema.String },
	User: {},
});
export type Caller = typeof Caller.Type;
export const Agent = Caller.cases.Agent;
export type Agent = typeof Agent.Type;

/** The caller as the desk's rules know them: which party. */
export const party = (by: Caller): Party => (by._tag === "Agent" ? "agent" : "user");

export const SessionInfo = Schema.Struct({
	id: SessionID,
	parentID: Schema.optional(SessionID),
	title: Schema.String,
	directory: Schema.String,
});
export type SessionInfo = typeof SessionInfo.Type;

export const Prompt = Schema.Struct({
	sessionID: SessionID,
	/** The message id: OpenCode admits each id once, so a retry can't deliver twice. */
	id: MessageID,
	text: Schema.String,
	delivery: Delivery,
	files: Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.String })),
});
export type Prompt = typeof Prompt.Type;

/** What the service asks a plugin to do in its OpenCode; `call` pairs it with the plugin's `reply`. */
export const ServiceCall = Schema.TaggedUnion({
	/** Look a session up: null when this OpenCode doesn't know it. */
	Session: { call: Schema.Int, sessionID: SessionID },
	Prompt: { call: Schema.Int, prompt: Prompt },
});
export type ServiceCall = typeof ServiceCall.Type;

export const Outcome = Schema.TaggedUnion({
	Session: { session: Schema.NullOr(SessionInfo) },
	Prompted: {},
	/** OpenCode (or the plugin) couldn't: what it said. */
	Failed: { cause: Schema.String },
});
export type Outcome = typeof Outcome.Type;

/** The two sides speak different versions; `side` is the outdated one. */
export class Outdated extends Schema.TaggedError<Outdated>()("Outdated", {
	side: Schema.Literals(["plugin", "service"]),
}) {}

export const Question = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
	labels: Schema.optional(Schema.Array(Schema.String)),
	parent: Schema.optional(EntryId),
	priority: Schema.optional(Priority),
});
export type Question = typeof Question.Type;

/** An attachment the page sends: its bytes, base64 on the wire. */
export const Attachment = Schema.Struct({ id: Schema.String, name: Schema.String, data: Schema.Uint8ArrayFromBase64 });
export type Attachment = typeof Attachment.Type;

/**
 * The user's text for an entry: an answer, or (on their own question) a follow-up. `files` holds the attachments the
 * text references (`attachment:<id>` in its Markdown); sending stores them as `attachments/<uuid>.<ext>`.
 */
export const Draft = Schema.Struct({
	entry: EntryId,
	text: Schema.String,
	files: Schema.optional(Schema.Array(Attachment)),
});
export type Draft = typeof Draft.Type;

/** A desk: a top-level session's, named after it (`sessions.ts`). */
export const DeskName = Schema.Struct({
	session: Schema.String,
	title: Schema.String,
	/** The last segment of the folder the session works in. */
	folder: Schema.String,
	/** Whether a connected OpenCode knows the session; one nobody knows may be gone, and its desk can be claimed. */
	known: Schema.Boolean,
});
export type DeskName = typeof DeskName.Type;

/** A desk with entries, for the list: how many wait on the user, and how many of those are critical. */
export const DeskSummary = Schema.Struct({ ...DeskName.fields, waiting: Schema.Int, critical: Schema.Int });
export type DeskSummary = typeof DeskSummary.Type;

/** One session's desk, every desk with entries (for switching), and the sessions in desk mode. */
export const View = Schema.Struct({
	desk: Schema.NullOr(DeskName),
	entries: Schema.Array(Entry),
	desks: Schema.Array(DeskSummary),
	/** The (top-level) sessions in desk mode, across the connected OpenCode instances. */
	deskMode: Schema.Array(Schema.String),
	/** Outbox (message id) → why its last delivery failed, for undelivered entries whose try failed. */
	failures: Schema.Record(Schema.String, DeliveryFailed),
});
export type View = typeof View.Type;

export const DeskApi = RpcGroup.make(
	// The bridge: a plugin instance and the service's calls into its OpenCode.
	Rpc.make("hello", {
		payload: { protocol: Schema.String },
		success: Schema.Struct({ url: Schema.String }),
		error: Outdated,
	}),
	/** The plugin instance's directory (for the log) and the sessions in desk mode there. */
	Rpc.make("attach", {
		payload: { directory: Schema.String, sessions: Schema.Array(SessionID) },
		success: ServiceCall,
		stream: true,
	}),
	Rpc.make("reply", { payload: { call: Schema.Int, outcome: Outcome } }),
	/** The sessions in desk mode in this plugin instance's directory, all of them, whenever one turns it on or off. */
	Rpc.make("modes", { payload: { sessions: Schema.Array(SessionID) } }),
	/** A session in this OpenCode moved to another directory: its desk's folder changes. */
	Rpc.make("moved", { payload: { session: SessionID } }),

	// The desk.
	/** An agent asks, on its session's desk. */
	Rpc.make("ask", {
		payload: { by: Agent, question: Question },
		success: Schema.Struct({ id: EntryId, parent: Schema.NullOr(EntryId), url: Schema.String }),
		error: Refusal,
	}),
	/** An agent answers the user's question; the user answers with their drafts (`submit`, `send`). */
	Rpc.make("answer", { payload: { by: Agent, id: EntryId, body: Schema.String }, error: Refusal }),
	/** The asker marks their question done. */
	Rpc.make("resolve", { payload: { by: Caller, id: EntryId }, error: Refusal }),
	Rpc.make("adopt", { payload: { id: EntryId, parent: EntryId }, error: Refusal }),
	Rpc.make("prioritize", { payload: { id: EntryId, priority: Priority, subtree: Schema.Boolean }, error: Refusal }),
	/** An agent's session takes over `from`'s desk: every entry of `from` becomes its. Returns how many. */
	Rpc.make("claim", { payload: { by: Agent, from: SessionID }, success: Schema.Int, error: Refusal }),
	/** `session`'s desk as text, or one entry in full. */
	Rpc.make("list", {
		payload: { session: SessionID, id: Schema.optional(EntryId) },
		success: Schema.String,
		error: Refusal,
	}),
	/** The page of `session`'s desk. */
	Rpc.make("page", { payload: { session: SessionID }, success: Schema.Struct({ url: Schema.String }) }),
	/** `session`'s desk now, then after every change; without one, only the list of desks. */
	Rpc.make("view", { payload: { session: Schema.optional(Schema.String) }, success: View, stream: true }),
	/** The user's drafts, all or nothing; one queued message per session. Returns how many went. */
	Rpc.make("submit", { payload: { drafts: Schema.Array(Draft) }, success: Schema.Int, error: Refusal }),
	/** One of the user's drafts, steering its session's current turn. */
	Rpc.make("send", { payload: Draft, error: Refusal }),
	/** The user gives up on delivering an entry's undelivered text (with the rest of its message); the text stays. */
	Rpc.make("discard", { payload: { entry: EntryId }, error: Refusal }),
);

export type { Delivery, Priority };
