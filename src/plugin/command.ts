/**
 * `/desk-mode`: turns desk mode on or off for the current session (and so its subagents), connects or hangs up to
 * match, and tells the agent what changed (and the user, by the message's description).
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Calls } from "./calls";
import type { Modes } from "./modes";

export interface Context extends Pick<Plugin.Context, "command" | "session"> {}

export interface Desk {
	readonly calls: Calls;
	readonly modes: Modes;
	/** Brings the connection in step with desk mode (`modes.follow`). */
	readonly sync: Effect.Effect<void>;
}

export const register = (ctx: Context, desk: Desk) =>
	ctx.command.transform((editor) => {
		editor.add({
			name: "desk-mode",
			description: "Turn desk mode on or off for this session: agents ask you questions on the desk instead of in chat",
			execute: Effect.fnUntraced(function* ({ sessionID }) {
				yield* desk.calls.available;
				const on = yield* desk.modes.toggle(sessionID);
				yield* desk.sync;

				const page = Option.isSome(on)
					? (yield* desk.calls.service((client) => client.page({ session: on.value }))).url
					: undefined;
				const url = page?.href;
				// The link that lets the user's browser in is for the user only: not in the agent's text, which goes into
				// the session's history and to its model.
				const authorized = page === undefined ? undefined : (yield* desk.calls.authorize(page)).href;
				const text = url
					? `Desk mode is on for this session. What you need from the user and what you tell them goes on the desk (desk_ask), not in chat, for this session and its subagents: in chat, questions and answers get lost as they come in out of order. That's every question, decision or review, and your replies too: to what they said on the desk (a follow-up under that entry) and to what they ask in chat, unless they ask for the reply in chat. One entry per question or decision: several go in several entries, and a reply that raises several things gets a follow-up for each. In chat, name an entry by its title at most (a critical one, say); don't retell it there. The user answers on <${url}>\n`
					: "Desk mode is off for this session: the desk_* tools are gone; ask the user in chat.";
				// The TUI shows a synthetic message by its description only (none: not at all); the text is for the agent.
				// A link with a label, so the token in its address isn't on the screen; the page drops it from the address bar
				// on arrival (a redirect, after it sets its cookie).
				const description = authorized ? `Desk mode on: [open the desk](${authorized})` : "Desk mode off";
				yield* ctx.session.synthetic({ sessionID, text, description, resume: false });
			}),
		});
	});
