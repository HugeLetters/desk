/**
 * `/desk-mode`: turns desk mode on or off for the current session (and so its subagents), connects or hangs up to
 * match, and tells the agent what changed (and the user, by the message's description).
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Calls } from "./calls";
import type { Modes } from "./modes";

export type Context = Pick<Plugin.Context, "command" | "session">;

/** `sync`: brings the connection in step with desk mode (`modes.follow`). */
export const register = (ctx: Context, desk: Calls & { readonly modes: Modes; readonly sync: Effect.Effect<void> }) =>
	ctx.command.transform((editor) => {
		editor.add({
			name: "desk-mode",
			description: "Turn desk mode on or off for this session: agents ask you questions on the desk instead of in chat",
			execute: ({ sessionID }) =>
				Effect.gen(function* () {
					const on = yield* desk.modes.toggle(sessionID);
					yield* desk.sync;
					const url = Option.isSome(on)
						? (yield* desk.service((client) => client.page({ session: on.value }))).url
						: undefined;
					const text = url
						? `Desk mode is on for this session. What you need from the user and what you tell them goes on the desk (desk_ask), not in chat, for this session and its subagents: in chat, questions and answers get lost as they come in out of order. That's every question, decision or review, and your replies too: to what they said on the desk (a follow-up under that entry) and to what they ask in chat, unless they ask for the reply in chat. One entry per question or decision: several go in several entries, and a reply that raises several things gets a follow-up for each. In chat, name an entry by its title at most (a critical one, say); don't retell it there. The user answers on <${url}>\n`
						: "Desk mode is off for this session: the desk_* tools are gone; ask the user in chat.";
					// The TUI shows a synthetic message by its description only (none: not at all); the text is for the agent.
					const description = url ? `Desk mode on: ${url}` : "Desk mode off";
					yield* ctx.session.synthetic({ sessionID, text, description, resume: false });
				}).pipe(desk.within),
		});
	});
