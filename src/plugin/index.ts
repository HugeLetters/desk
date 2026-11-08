/**
 * The desk in OpenCode: a thin, stateless client of the desk service. It adds
 *
 * - `/desk`, which turns the desk on or off for the current session (off by default), kept in the plugin's storage
 *   as `on/<root session id>`, so a session's subagents follow it;
 * - the `desk_*` tools, which forward to the service and which only sessions with the desk on get to see.
 *
 * Options (`opencode.json` `plugins: [{ package, options }]`): `home` (the store, default `$DESK_HOME` or
 * `~/.local/share/desk`), `port` (the page, default `$DESK_PORT` or 47400), and `opencode` (`{ url, password }`:
 * this OpenCode's endpoint, found by itself when it's the machine's OpenCode service).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Endpoint, Methods } from "../protocol";
import { connect, startService } from "./connection";

const media =
	"Markdown: text, code fences, ```mermaid diagrams, images and GIFs (![alt](path)), video (![alt](clip.mp4)). Link files by path relative to the session's directory, e.g. ![icon](design/icons/01.png).";

const priority = { type: "string", enum: ["critical", "high", "normal", "low"] } as const;

/** This OpenCode's endpoint, when it is the machine's OpenCode service (its registration names this process). */
function ownEndpoint(): Endpoint | undefined {
	try {
		const file = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "opencode", "service.json");
		const info = JSON.parse(readFileSync(file, "utf8")) as { url: string; pid: number; password?: string };
		return info.pid === process.pid ? { url: info.url, password: info.password } : undefined;
	} catch {
		return undefined;
	}
}

export default Plugin.define({
	id: "desk",
	async setup(ctx) {
		const home = String(ctx.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk")).replace(/^~(?=\/|$)/, homedir());
		const port = String(ctx.options.port ?? process.env.DESK_PORT ?? 47400);
		const opencode = (ctx.options.opencode as Endpoint | undefined) ?? ownEndpoint();
		const service = connect({
			socket: join(home, "desk.sock"),
			start: () => startService({ DESK_HOME: home, DESK_PORT: port }),
			hello: () => ({ opencode, project: { id: ctx.location.project.id, directory: ctx.location.project.directory } }),
		});

		/** A session's top-level session: a subagent's desk is its parent's. Parents never change, so it's cached. */
		const roots = new Map<string, Promise<string>>();
		const root = (sessionID: string): Promise<string> => {
			let found = roots.get(sessionID);
			if (!found) {
				found = ctx.session.get({ sessionID: sessionID as never }).then((session) => (session.parentID ? root(session.parentID) : session.id));
				found.catch(() => roots.delete(sessionID));
				roots.set(sessionID, found);
			}
			return found;
		};
		const key = (rootID: string) => `on/${rootID}`;
		const on = async (sessionID: string) => (await ctx.storage.get(key(await root(sessionID)))) === true;

		const names = ["desk_ask", "desk_adopt", "desk_answer", "desk_resolve", "desk_prioritize", "desk_list"];
		/** Runs a tool for a session with the desk on. */
		const tool =
			<I>(run: (input: I, sessionID: string) => Promise<string>) =>
			async (input: unknown, context: { sessionID: string }) => {
				if (!(await on(context.sessionID))) throw new Error("The desk is off for this session; the user turns it on with /desk.");
				return { content: await run(input as I, context.sessionID) };
			};

		await ctx.command.transform((editor) => {
			editor.add({
				name: "desk",
				description: "Turn the desk on or off for this session: agents ask you questions there instead of in chat",
				execute: async ({ sessionID }) => {
					const rootID = await root(sessionID);
					const now = !(await ctx.storage.get(key(rootID)));
					if (now) await ctx.storage.set(key(rootID), true);
					else await ctx.storage.remove(key(rootID));
					const text = now
						? `The desk is on for this session: agents may ask the user there (desk_ask) instead of in chat. The user answers on ${(await service.request("page", { session: rootID })).url}`
						: "The desk is off for this session: the desk_* tools are gone; ask the user in chat.";
					await ctx.session.synthetic({ sessionID, text, resume: false });
				},
			});
		});

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "desk_ask",
				description: `Ask the user a question (or request a review) on the desk instead of in chat. The user answers on the desk page; the answer arrives later as a message in this session's top-level session. Use parent to follow up on an entry. A PR's questions (label pr:<n>) are filed under that PR's review entry automatically when parent is omitted; an entry labelled review is itself a PR's review entry and stays top-level. ${media}`,
				input: {
					type: "object",
					properties: {
						title: { type: "string", description: "One line: the question itself." },
						body: { type: "string", description: "Context, options and your recommendation, in Markdown." },
						labels: { type: "array", items: { type: "string" }, description: "Short topic tags, e.g. glossary, review." },
						parent: { type: "string", description: "The id of the entry this follows up on." },
						priority: { ...priority, description: "critical (a decision blocking work right now, e.g. the disk is full), high, normal or low; the user sees higher priority first. Default: the parent's." },
					},
					required: ["title", "body"],
					additionalProperties: false,
				},
				options: { codemode: false },
				execute: tool<Methods["ask"]["input"]["question"]>(async (question, sessionID) => {
					const session = await ctx.session.get({ sessionID: (await root(sessionID)) as never });
					const asked = await service.request("ask", { asker: { session: session.id, directory: session.location.directory }, question });
					const where = asked.parent === null ? "top-level" : `under ${asked.parent}${question.parent === undefined ? " (the PR's review entry)" : ""}`;
					return `Asked ${asked.id}, ${where}. ${asked.url}`;
				}),
			});
			editor.add({
				name: "desk_adopt",
				description: "File a top-level entry (one without a parent) under another entry, e.g. a PR's question asked before its review entry existed. Only once: an entry's parent never changes after that.",
				input: {
					type: "object",
					properties: { id: { type: "string" }, parent: { type: "string", description: "The entry to file it under; not inside the entry's own subtree." } },
					required: ["id", "parent"],
					additionalProperties: false,
				},
				options: { codemode: false },
				execute: tool<{ id: string; parent: string }>(async (input) => {
					await service.request("adopt", input);
					return `Filed ${input.id} under ${input.parent}.`;
				}),
			});
			editor.add({
				name: "desk_answer",
				description: `Answer a question the user asked on the desk. ${media}`,
				input: {
					type: "object",
					properties: { id: { type: "string" }, body: { type: "string", description: "The answer, in Markdown." } },
					required: ["id", "body"],
					additionalProperties: false,
				},
				options: { codemode: false },
				execute: tool<{ id: string; body: string }>(async (input) => {
					await service.request("answer", input);
					return `Answered ${input.id}.`;
				}),
			});
			editor.add({
				name: "desk_resolve",
				description: "Mark one of your own desk questions done, once its outcome is applied (glossary, ADR, issue, code). Refused while anything below it is unresolved (the error lists those ids): resolve or wait for them first. Resolved entries without open follow-ups leave the desk.",
				input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
				options: { codemode: false },
				execute: tool<{ id: string }>(async (input) => {
					await service.request("resolve", input);
					return `Resolved ${input.id}.`;
				}),
			});
			editor.add({
				name: "desk_prioritize",
				description: "Change an entry's priority (critical, high, normal, low): the user sees higher priority first, e.g. bump a main PR's review thread. With subtree, the entry and everything below it.",
				input: {
					type: "object",
					properties: { id: { type: "string" }, priority, subtree: { type: "boolean" } },
					required: ["id", "priority"],
					additionalProperties: false,
				},
				options: { codemode: false },
				execute: tool<{ id: string; priority: Methods["prioritize"]["input"]["priority"]; subtree?: boolean }>(async (input) => {
					await service.request("prioritize", { id: input.id, priority: input.priority, subtree: input.subtree ?? false });
					return `Set ${input.id} to ${input.priority}${input.subtree ? " (with everything below it)" : ""}.`;
				}),
			});
			editor.add({
				name: "desk_list",
				description: "Show this project's desk: every unresolved entry (id, title, whose turn it is), or one entry's full thread when id is given. Entry ids are full UUIDs; the user may paste one.",
				input: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
				options: { codemode: false },
				execute: tool<{ id?: string }>(async (input, sessionID) => service.request("list", { session: await root(sessionID), id: input.id })),
			});
		});

		// Sessions with the desk off don't see the tools at all.
		await ctx.session.hook("context", async (event) => {
			if (await on(event.sessionID).catch(() => false)) return;
			for (const name of names) delete event.tools[name];
		});

		return () => service.close();
	},
});
