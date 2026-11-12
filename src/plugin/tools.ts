/**
 * The `desk_*` tools, which forward to the service, and which only sessions with desk mode on get to see. A tool's
 * failure reaches the model as its error: what the desk refused, worded (`wording.ts`), or why the service can't be
 * reached.
 */
import type { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EntryId, Priority, SessionID } from "../entry";
import { Refusal } from "../errors";
import type { Question } from "../protocol";
import { refusal } from "../wording";
import type { Calls } from "./calls";
import * as Connection from "./connection";
import type { Modes } from "./modes";

export type Context = Pick<Plugin.Context, "tool" | "session">;

const media =
	"Markdown: text, code fences, ```mermaid diagrams, images and GIFs (![alt](path)), video (![alt](clip.mp4)). Link files by path relative to the session's directory, e.g. ![icon](design/icons/01.png).";

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description });

const isRefusal = Schema.is(Refusal);

/** What the tools use: desk mode, a session's top-level session, and the service. */
export interface Desk extends Calls {
	readonly modes: Modes;
	readonly root: (sessionID: SessionID) => Effect.Effect<SessionID, unknown>;
}

/** A tool as the editor takes any of them, its input's type checked against its schema here. */
const define = <Input extends Tool.ValueSchema>(info: Tool.Info<Input, undefined>): Tool.Info => info;

/** The tools, for `ctx` and `desk`. */
const tools = (ctx: Context, desk: Desk): ReadonlyArray<Tool.Info> => {
	const { service, root } = desk;
	/** Runs a tool for a session with the desk on; any failure reaches the model as the tool's error. */
	const tool =
		<I, E>(run: (input: I, sessionID: SessionID) => Effect.Effect<string, E>) =>
		(input: I, context: Tool.Context) =>
			Effect.gen(function* () {
				if (!(yield* desk.modes.on(context.sessionID))) {
					return yield* new Tool.Error({
						message: "The desk is off for this session; the user turns it on with /desk-mode.",
					});
				}

				return { content: yield* run(input, context.sessionID) };
			}).pipe(
				desk.within,
				Effect.mapError((error) =>
					error instanceof Tool.Error
						? error
						: new Tool.Error({
								message: isRefusal(error) ? refusal(error) : Connection.errorMessage(error),
							}),
				),
			);

	return [
		define({
			name: "desk_ask",
			description: `Ask the user a question, request a review, or reply to them, on the desk. With desk mode on, every question for the user goes here, never in chat, where it gets lost among out-of-order answers. The user answers on the desk page; the answer arrives later as a message in this session's top-level session. Use parent to follow up on an entry. A PR's questions (label pr:<n>) are filed under that PR's review entry automatically when parent is omitted; an entry labelled review is itself a PR's review entry and stays top-level. The user reads the whole question on the desk: in chat, refer to it by its title instead of repeating its content. Each top-level session has its own desk; a parent must be on it. To file an entry under another later (desk_adopt), change its priority (desk_prioritize) or take over a gone session's desk (desk_claim), find those tools with Code Mode's search. ${media}`,
			input: Schema.Struct({
				title: described(Schema.String, "One line: the question itself."),
				body: described(Schema.String, "Context, options and your recommendation, in Markdown."),
				labels: Schema.optional(described(Schema.Array(Schema.String), "Short topic tags, e.g. glossary, review.")),
				parent: Schema.optional(described(EntryId, "The id of the entry this follows up on.")),
				priority: Schema.optional(
					described(
						Priority,
						"critical (a decision blocking work right now, e.g. the disk is full), high, normal or low; the user sees higher priority first. Default: the parent's.",
					),
				),
			}),
			options: { codemode: false },
			execute: tool((question: Question, sessionID) =>
				Effect.gen(function* () {
					const session = yield* ctx.session.get({ sessionID: yield* root(sessionID) });
					const asked = yield* service((client) =>
						client.ask({
							asker: { session: session.id, directory: session.location.directory },
							question,
						}),
					);
					const where =
						asked.parent === null
							? "top-level"
							: `under ${asked.parent}${question.parent === undefined ? " (the PR's review entry)" : ""}`;
					return `Asked ${asked.id}, ${where}.`;
				}),
			),
		}),
		define({
			name: "desk_adopt",
			description:
				"File a top-level entry (one without a parent) under another entry, e.g. a PR's question asked before its review entry existed. Only once: an entry's parent never changes after that.",
			input: Schema.Struct({
				id: EntryId,
				parent: described(EntryId, "The entry to file it under; not inside the entry's own subtree."),
			}),
			// Rarely needed: in Code Mode, out of every request's tool list (`desk_ask` names it).
			options: { codemode: true },
			execute: tool((input: { id: EntryId; parent: EntryId }) =>
				service((client) => client.adopt(input)).pipe(Effect.as(`Filed ${input.id} under ${input.parent}.`)),
			),
		}),
		define({
			name: "desk_answer",
			description: "Answer a question the user asked on the desk. Markdown, as in desk_ask.",
			input: Schema.Struct({ id: EntryId, body: described(Schema.String, "The answer, in Markdown.") }),
			options: { codemode: false },
			execute: tool((input: { id: EntryId; body: string }) =>
				service((client) => client.answer(input)).pipe(Effect.as(`Answered ${input.id}.`)),
			),
		}),
		define({
			name: "desk_resolve",
			description:
				"Mark one of your own desk questions done, once its outcome is applied (glossary, ADR, issue, code). Refused while anything below it is unresolved (the error lists those ids): resolve or wait for them first. Resolved entries without open follow-ups leave the desk.",
			input: Schema.Struct({ id: EntryId }),
			options: { codemode: false },
			execute: tool((input: { id: EntryId }) =>
				service((client) => client.resolve(input)).pipe(Effect.as(`Resolved ${input.id}.`)),
			),
		}),
		define({
			name: "desk_prioritize",
			description:
				"Change an entry's priority (critical, high, normal, low): the user sees higher priority first, e.g. bump a main PR's review thread. With subtree, the entry and everything below it.",
			input: Schema.Struct({ id: EntryId, priority: Priority, subtree: Schema.optional(Schema.Boolean) }),
			// Rarely needed: in Code Mode, out of every request's tool list (`desk_ask` names it).
			options: { codemode: true },
			execute: tool((input: { id: EntryId; priority: Priority; subtree?: boolean | undefined }) =>
				service((client) =>
					client.prioritize({ id: input.id, priority: input.priority, subtree: input.subtree ?? false }),
				).pipe(Effect.as(`Set ${input.id} to ${input.priority}${input.subtree ? " (with everything below it)" : ""}.`)),
			),
		}),
		define({
			name: "desk_list",
			description:
				"Show this session's desk (its subagents share it): every unresolved entry, one line each (id, title, [status, whose turn, priority, from the user]), or one entry in full when id is given (with the entries it hangs under and its follow-ups as one line each). Entry ids are full UUIDs; the user may paste one.",
			input: Schema.Struct({ id: Schema.optional(EntryId) }),
			options: { codemode: false },
			execute: tool((input: { id?: EntryId | undefined }, sessionID) =>
				Effect.flatMap(root(sessionID), (session) => service((client) => client.list({ session, id: input.id }))),
			),
		}),
		define({
			name: "desk_claim",
			description:
				"Take over another session's desk: every entry of that session (open questions, undelivered answers) becomes this session's, so this session can list, answer and resolve them, and their answers come here. For a desk left by a session that's gone (the page shows it as unknown). Refused while that session is in desk mode.",
			input: Schema.Struct({ from: described(SessionID, "The session whose desk to take over (ses_…).") }),
			// Rarely needed: in Code Mode, out of every request's tool list (`desk_ask` names it).
			options: { codemode: true },
			execute: tool((input: { from: SessionID }, sessionID) =>
				Effect.flatMap(root(sessionID), (session) =>
					service((client) => client.claim({ session, from: input.from })).pipe(
						Effect.map((count) => `Claimed ${count} ${count === 1 ? "entry" : "entries"} from ${input.from}'s desk.`),
					),
				),
			),
		}),
	];
};

/**
 * Registers the tools, and hides them from sessions with desk mode off.
 *
 * OpenCode's tools aren't per session: `tool.transform` registers them for every session of this OpenCode at once
 * (and `tool.reload` runs every transform again, for all of them), so there's no adding a session's tools when it
 * turns desk mode on. What each model request offers is per session, though: the session's `context` hook gets that
 * request's tools, and takes the desk's out of them while the session's desk mode is off. A tool called anyway
 * refuses (`tool` above).
 */
export const register = (ctx: Context, desk: Desk) =>
	Effect.gen(function* () {
		const all = tools(ctx, desk);
		yield* ctx.tool.transform((editor) => {
			for (const one of all) editor.add(one);
		});
		const names = all.map((one) => one.name);
		yield* ctx.session.hook("context", (event) =>
			Effect.map(
				Effect.orElseSucceed(desk.modes.on(event.sessionID), () => false),
				(on) => {
					// The hook's request is edited in place: that's how OpenCode's hooks answer.
					if (!on) for (const name of names) delete event.tools[name];
				},
			),
		);
	});
