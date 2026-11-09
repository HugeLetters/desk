/**
 * Plugin ↔ service, over the service's Unix socket: an RPC group (`effect/rpc`, newline-delimited JSON), checked
 * against these schemas on both sides.
 *
 * A plugin instance says `hello` (the one request whose shape never changes, so two versions can always compare), then
 * holds `attach` open for as long as it's connected: the attachment lives exactly as long as that stream. The service
 * can't call a client, so its calls into the plugin's OpenCode (look a session up, prompt one) go out on that stream as
 * `ServiceCall`s, and the plugin answers each with `reply`. So the service needs no endpoint or password of its own.
 * Everything else is an ordinary request; what the desk refuses comes back as a typed `Refusal`.
 */

import { readFileSync } from "node:fs";
import { ProjectID } from "@opencode/schema/project-id";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { Delivery, EntryId, MessageID, Priority, SessionID } from "./entry";
import { Refusal } from "./errors";

export const SessionInfo = Schema.Struct({
	id: SessionID,
	parentID: Schema.optional(SessionID),
	projectID: ProjectID,
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

export const Asker = Schema.Struct({ session: SessionID, directory: Schema.String });
export const Question = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
	labels: Schema.optional(Schema.Array(Schema.String)),
	parent: Schema.optional(EntryId),
	priority: Schema.optional(Priority),
});
export type Question = typeof Question.Type;

export const PluginApi = RpcGroup.make(
	Rpc.make("hello", {
		payload: { protocol: Schema.String },
		success: Schema.Struct({ url: Schema.String }),
		error: Outdated,
	}),
	/** The plugin instance's location's project (for the project's name) and the sessions in desk mode there. */
	Rpc.make("attach", {
		payload: { project: Schema.Struct({ id: ProjectID, directory: Schema.String }), sessions: Schema.Array(SessionID) },
		success: ServiceCall,
		stream: true,
	}),
	Rpc.make("reply", { payload: { call: Schema.Int, outcome: Outcome } }),
	/** The sessions in desk mode in this plugin instance's directory, all of them, whenever one turns it on or off. */
	Rpc.make("modes", { payload: { sessions: Schema.Array(SessionID) } }),
	/** A session in this OpenCode moved to another directory (perhaps another project). */
	Rpc.make("moved", { payload: { session: SessionID } }),
	Rpc.make("ask", {
		payload: { asker: Asker, question: Question },
		success: Schema.Struct({ id: EntryId, parent: Schema.NullOr(EntryId), url: Schema.String }),
		error: Refusal,
	}),
	Rpc.make("adopt", { payload: { id: EntryId, parent: EntryId }, error: Refusal }),
	Rpc.make("answer", { payload: { id: EntryId, body: Schema.String }, error: Refusal }),
	Rpc.make("resolve", { payload: { id: EntryId }, error: Refusal }),
	Rpc.make("prioritize", { payload: { id: EntryId, priority: Priority, subtree: Schema.Boolean }, error: Refusal }),
	/** The desk of `session`'s project, or one entry in full. */
	Rpc.make("list", {
		payload: { session: SessionID, id: Schema.optional(EntryId) },
		success: Schema.String,
		error: Refusal,
	}),
	/** The page for `session`'s project. */
	Rpc.make("page", { payload: { session: SessionID }, success: Schema.Struct({ url: Schema.String }) }),
);

/**
 * The contract's code: this file, what it imports from the desk, and the dependencies' versions (`bun.lock`, for the
 * OpenCode schemas). Only these: a change to either side's own code doesn't make the other side outdated, so the
 * service can be restarted on its own, and the plugin reloaded on its own.
 */
const contract = ["src/protocol.ts", "src/entry.ts", "src/errors.ts", "bun.lock"].map(
	(file) => new URL(`../${file}`, import.meta.url).pathname,
);

const hash = (texts: ReadonlyArray<string>) =>
	Bun.hash(contract.map((file, index) => `${file}\0${texts[index]}`).join("\0")).toString(36);

/** The contract's version as it's on disk now: a hash of its code. Nothing is bumped by hand. */
export const build = Effect.flatMap(FileSystem.FileSystem, (fs) =>
	Effect.map(
		Effect.forEach(contract, (file) => fs.readFileString(file)),
		hash,
	),
);

/**
 * The version this side speaks: the contract's code it loaded. Plugin and service compare it on `hello`. A hash can't
 * say which side is older; the service decides (`socket.ts`). Read while the module loads, synchronously: both sides
 * need it before any of their services exist.
 */
export const protocol = hash(contract.map((file) => readFileSync(file, "utf8")));

export type { Delivery, Priority };
