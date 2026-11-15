/**
 * The TUI badge's view of the desk, as the server part of the plugin gives it over OpenCode's plugin RPC: `status` (what
 * this plugin instance knows now) and `changed` (every change after). One instance per directory, so the TUI calls
 * each location's and tells their events apart by `location`.
 *
 * Between the desk's own two parts, in one OpenCode: not the desk service's contract (`api.ts`), nor its version, though
 * a desk is the contract's summary, picked. Only schemas here, so the TUI imports nothing else of the plugin's but
 * those; its client (`tui/rpc-client.ts`) makes them portable.
 */
import { Rpc } from "@opencode/schema/rpc";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { DeskSummary } from "../api/api";
import type { Identity } from "../shared/type";

/**
 * A desk: how many entries wait on the user, and how many of those are critical. The API's {@link DeskSummary}, picked:
 * encoding drops its other fields, so the plugin passes the service's summaries as they are.
 */
export const Desk = DeskSummary.mapFields(Struct.pick(["session", "waiting", "critical"]));
export interface Desk extends Identity<typeof Desk.Type> {}

/** What a connected plugin instance knows: the service's page and the desks' summary. */
export const Live = Schema.Struct({
	/** The page, e.g. `http://127.0.0.1:47400/`. */
	url: Schema.String,
	desks: Schema.Array(Desk),
	/** The top-level sessions in desk mode, in every OpenCode. */
	deskMode: Schema.Array(Schema.String),
});
export interface Live extends Identity<typeof Live.Type> {}

/** A plugin instance's status: `live` is null while it isn't connected to the service (no badge). */
export const Status = Schema.Struct({ live: Schema.NullOr(Live) });
export interface Status extends Identity<typeof Status.Type> {}

/** Not connected. */
export const off: Status = { live: null };

export const sameStatus = Schema.toEquivalence(Status);

export const BadgeRpc = Rpc.define({
	id: "desk",
	methods: {
		/** This plugin instance's status now. */
		status: { input: Schema.Struct({}), output: Status },
	},
	events: {
		/** The status, whenever it changes. */
		changed: { schema: Status },
	},
});
