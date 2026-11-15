/**
 * The TUI badge's view of a desk, as the server part of the plugin gives it over OpenCode's plugin RPC: `status` (a
 * session's badge now) and `changed` (ask again). One instance per directory, so the TUI asks the instance of the
 * session's directory, the one connected while that session is in desk mode.
 *
 * Between the desk's own two parts, in one OpenCode: not the desk service's contract (`api.ts`), nor its version. Only
 * schemas here, so the TUI imports nothing else of the plugin's but those; its client (`tui/rpc-client.ts`) makes them
 * portable.
 */
import { Rpc } from "@opencode/schema/rpc";
import * as Schema from "effect/Schema";
import { SessionID } from "../model/entry";
import type { Identity } from "../shared/type";

/** A session's badge: its desk's page, how many entries there wait on the user, and how many of those are critical. */
export const Status = Schema.Struct({
	/** The desk's page, e.g. `http://127.0.0.1:47400/sessions/ses_…`. */
	page: Schema.URLFromString,
	waiting: Schema.Number,
	critical: Schema.Number,
});
export interface Status extends Identity<typeof Status.Type> {}

export const BadgeRpc = Rpc.define({
	id: "desk",
	methods: {
		/**
		 * The badge of `session` (a subagent's is its top-level session's desk): null while that desk isn't in desk mode,
		 * or this plugin instance isn't connected to the service. Fails while OpenCode can't say which desk it is.
		 */
		status: {
			input: Schema.Struct({ session: SessionID }),
			output: Schema.NullOr(Status),
			errors: { opencode: Schema.Struct({}) },
		},
	},
	events: {
		/** Something this plugin instance knows changed: ask again. */
		changed: { schema: Schema.Struct({}) },
	},
});
