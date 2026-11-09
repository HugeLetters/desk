/**
 * The desk in OpenCode: a thin, stateless client of the desk service. It adds
 *
 * - `/desk-mode`, which turns desk mode on or off for the current session (off by default), kept in the plugin's storage
 *   as `on/<root session id>`, so a session's subagents follow it;
 * - the `desk_*` tools, which forward to the service and which only sessions with the desk on get to see.
 *
 * For the service, it's also the way into this OpenCode: it looks sessions up and delivers the user's replies here
 * when the service asks, and tells the service about sessions that move.
 *
 * Options (`opencode.json` `plugins: [{ package, options }]`): `home` (the store, default `$DESK_HOME` or
 * `~/.local/share/desk`) and `port` (the page's preferred port, default `$DESK_PORT` or 47400; any free one when it's taken).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EntryId, Priority, SessionID } from "../entry";
import { type Methods, protocol } from "../protocol";
import * as Connection from "./connection";

const media =
	"Markdown: text, code fences, ```mermaid diagrams, images and GIFs (![alt](path)), video (![alt](clip.mp4)). Link files by path relative to the session's directory, e.g. ![icon](design/icons/01.png).";

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description });

/** Whether `error` is OpenCode saying it doesn't know the session. */
const notFound = (error: unknown) => typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError";

export default Plugin.define({
	id: "desk",
	effect: (ctx) =>
		Effect.gen(function* () {
			const home = String(ctx.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk")).replace(/^~(?=\/|$)/, homedir());
			const port = String(ctx.options.port ?? process.env.DESK_PORT ?? 47400);
			/** The sessions in desk mode in this plugin instance's directory (`on/<id>` in the plugin's storage), forgetting deleted ones. */
			const modes = Effect.gen(function* () {
				const sessions: Array<SessionID> = [];
				for (let after: string | undefined; ; ) {
					const page = yield* ctx.storage.scan({ prefix: "on/", after });
					sessions.push(...page.entries.map((entry) => SessionID.make(entry.key.slice("on/".length))));
					if (page.next === undefined) break;
					after = page.next;
				}
				const where = yield* Effect.forEach(sessions, (id) =>
					ctx.session.get({ sessionID: id }).pipe(
						Effect.map((session) => (session.location.directory === ctx.location.directory ? "here" : "elsewhere")),
						Effect.catchIf(notFound, () => Effect.succeed("gone" as const)),
						Effect.orElseSucceed(() => "elsewhere" as const),
					),
				);
				yield* Effect.forEach(
					sessions.filter((_, index) => where[index] === "gone"),
					(id) => ctx.storage.remove(`on/${id}`),
				);
				return sessions.filter((_, index) => where[index] === "here");
			});
			const options: Connection.Options = {
				socket: join(home, "desk.sock"),
				start: Connection.startService({ DESK_HOME: home, DESK_PORT: port }),
				hello: { protocol, project: { id: ctx.location.project.id, directory: ctx.location.project.directory } },
				modes,
				serve: {
					session: ({ sessionID }) =>
						ctx.session.get({ sessionID }).pipe(
							Effect.map((session) => ({ id: session.id, parentID: session.parentID ?? undefined, projectID: session.projectID, directory: session.location.directory })),
							// Not this OpenCode's session; anything else is an error the service retries.
							Effect.catchIf(notFound, () => Effect.succeed(null)),
						),
					prompt: ({ sessionID, id, text, delivery, files }) =>
						ctx.session.prompt({ sessionID, id, text, delivery, files: files.map((file) => ({ uri: file.uri, name: file.name })) }).pipe(Effect.as(null)),
				},
			};

			// Connected (and so starting the service) only while a session in this directory is in desk mode: the page
			// counts those sessions, and a plugin instance with none has nothing to ask or deliver.
			const pluginScope = yield* Effect.scope;
			const lock = yield* Semaphore.make(1);
			let held: { scope: Scope.Closeable; connection: Connection.Connection } | undefined;
			/** Connects, reports the sessions in desk mode, or hangs up, to match the storage. */
			const sync = Semaphore.withPermits(
				lock,
				1,
			)(
				Effect.gen(function* () {
					const mine = yield* modes;
					if (mine.length === 0) {
						if (held) yield* Scope.close(held.scope, Exit.void);
						held = undefined;
					} else if (held) yield* Effect.ignore(held.connection.request("modes", { sessions: mine }));
					else {
						const scope = yield* Scope.fork(pluginScope);
						held = { scope, connection: yield* Scope.provide(Connection.make(options), scope) };
					}
				}),
			);
			yield* sync;
			const service: Connection.Connection = {
				request: (method, input) =>
					held ? held.connection.request(method, input) : Effect.fail(new Connection.DeskError({ message: "Desk mode is off in this directory; the user turns it on with /desk-mode." })),
				url: Effect.suspend(() => (held ? held.connection.url : Effect.fail(new Connection.DeskError({ message: "Desk mode is off in this directory." })))),
			};
			// The service's project cache drops a session that moves, so its entries follow it.
			yield* ctx.event.subscribe({ types: ["session.moved"] }).pipe(
				// A session moving in or out of this directory may connect or hang up this instance, too.
				Stream.runForEach((event) => Effect.andThen(Effect.ignore(service.request("moved", { session: event.data.sessionID })), sync)),
				Effect.ignore,
				Effect.forkScoped,
			);

			/** A session's top-level session: a subagent's desk is its parent's. Parents never change, so it's cached. */
			const roots = new Map<SessionID, SessionID>();
			const root = (sessionID: SessionID): Effect.Effect<SessionID, unknown> => {
				const known = roots.get(sessionID);
				if (known) return Effect.succeed(known);
				return ctx.session.get({ sessionID }).pipe(
					Effect.flatMap((session) => (session.parentID ? root(session.parentID) : Effect.succeed(session.id))),
					Effect.tap((found) => Effect.sync(() => roots.set(sessionID, found))),
				);
			};
			const key = (rootID: SessionID) => `on/${rootID}`;
			const on = (sessionID: SessionID) => Effect.flatMap(root(sessionID), (rootID) => Effect.map(ctx.storage.get(key(rootID)), (value) => value === true));

			const names = ["desk_ask", "desk_adopt", "desk_answer", "desk_resolve", "desk_prioritize", "desk_list"];
			/** Runs a tool for a session with the desk on; any failure reaches the model as the tool's error. */
			const tool =
				<I>(run: (input: I, sessionID: SessionID) => Effect.Effect<string, unknown>) =>
				(input: I, context: Tool.Context) =>
					Effect.gen(function* () {
						if (!(yield* on(context.sessionID))) return yield* Effect.fail(new Error("The desk is off for this session; the user turns it on with /desk-mode."));
						return { content: yield* run(input, context.sessionID) };
					}).pipe(Effect.mapError((error) => (error instanceof Tool.Error ? error : new Tool.Error({ message: Connection.errorMessage(error) }))));

			yield* ctx.command.transform((editor) => {
				editor.add({
					name: "desk-mode",
					description: "Turn desk mode on or off for this session: agents ask you questions on the desk instead of in chat",
					execute: ({ sessionID }) =>
						Effect.gen(function* () {
							const rootID = yield* root(sessionID);
							const now = (yield* ctx.storage.get(key(rootID))) !== true;
							if (now) yield* ctx.storage.set(key(rootID), true);
							else yield* ctx.storage.remove(key(rootID));
							yield* sync;
							const url = now ? (yield* service.request("page", { session: rootID })).url : undefined;
							const text = url
								? `Desk mode is on for this session. Every question, decision or review you need from the user goes on the desk (desk_ask), not in chat, for this session and its subagents: in chat, questions and answers get lost as they come in out of order. A critical one may also be mentioned in chat, by its title. The user answers on <${url}>\n`
								: "Desk mode is off for this session: the desk_* tools are gone; ask the user in chat.";
							// The TUI shows a synthetic message by its description only (none: not at all); the text is for the agent.
							const description = url ? `Desk mode on: ${url}` : "Desk mode off";
							yield* ctx.session.synthetic({ sessionID, text, description, resume: false });
						}),
				});
			});

			yield* ctx.tool.transform((editor) => {
				editor.add({
					name: "desk_ask",
					description: `Ask the user a question (or request a review) on the desk. With desk mode on, every question for the user goes here, never in chat, where it gets lost among out-of-order answers. The user answers on the desk page; the answer arrives later as a message in this session's top-level session. Use parent to follow up on an entry. A PR's questions (label pr:<n>) are filed under that PR's review entry automatically when parent is omitted; an entry labelled review is itself a PR's review entry and stays top-level. The user reads the whole question on the desk: in chat, refer to it by its title instead of repeating its content. ${media}`,
					input: Schema.Struct({
						title: described(Schema.String, "One line: the question itself."),
						body: described(Schema.String, "Context, options and your recommendation, in Markdown."),
						labels: Schema.optional(described(Schema.Array(Schema.String), "Short topic tags, e.g. glossary, review.")),
						parent: Schema.optional(described(EntryId, "The id of the entry this follows up on.")),
						priority: Schema.optional(
							described(Priority, "critical (a decision blocking work right now, e.g. the disk is full), high, normal or low; the user sees higher priority first. Default: the parent's."),
						),
					}),
					options: { codemode: false },
					execute: tool((question: Methods["ask"]["input"]["question"], sessionID) =>
						Effect.gen(function* () {
							const session = yield* ctx.session.get({ sessionID: (yield* root(sessionID)) as never });
							const asked = yield* service.request("ask", { asker: { session: session.id, directory: session.location.directory }, question });
							const where = asked.parent === null ? "top-level" : `under ${asked.parent}${question.parent === undefined ? " (the PR's review entry)" : ""}`;
							return `Asked ${asked.id}, ${where}.`;
						}),
					),
				});
				editor.add({
					name: "desk_adopt",
					description: "File a top-level entry (one without a parent) under another entry, e.g. a PR's question asked before its review entry existed. Only once: an entry's parent never changes after that.",
					input: Schema.Struct({ id: EntryId, parent: described(EntryId, "The entry to file it under; not inside the entry's own subtree.") }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId; parent: EntryId }) => service.request("adopt", input).pipe(Effect.as(`Filed ${input.id} under ${input.parent}.`))),
				});
				editor.add({
					name: "desk_answer",
					description: "Answer a question the user asked on the desk. Markdown, as in desk_ask.",
					input: Schema.Struct({ id: EntryId, body: described(Schema.String, "The answer, in Markdown.") }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId; body: string }) => service.request("answer", input).pipe(Effect.as(`Answered ${input.id}.`))),
				});
				editor.add({
					name: "desk_resolve",
					description: "Mark one of your own desk questions done, once its outcome is applied (glossary, ADR, issue, code). Refused while anything below it is unresolved (the error lists those ids): resolve or wait for them first. Resolved entries without open follow-ups leave the desk.",
					input: Schema.Struct({ id: EntryId }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId }) => service.request("resolve", input).pipe(Effect.as(`Resolved ${input.id}.`))),
				});
				editor.add({
					name: "desk_prioritize",
					description: "Change an entry's priority (critical, high, normal, low): the user sees higher priority first, e.g. bump a main PR's review thread. With subtree, the entry and everything below it.",
					input: Schema.Struct({ id: EntryId, priority: Priority, subtree: Schema.optional(Schema.Boolean) }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId; priority: Methods["prioritize"]["input"]["priority"]; subtree?: boolean | undefined }) =>
						service
							.request("prioritize", { id: input.id, priority: input.priority, subtree: input.subtree ?? false })
							.pipe(Effect.as(`Set ${input.id} to ${input.priority}${input.subtree ? " (with everything below it)" : ""}.`)),
					),
				});
				editor.add({
					name: "desk_list",
					description: "Show this project's desk: every unresolved entry, one line each (id, title, [status, whose turn, priority, from the user]), or one entry in full when id is given (with the entries it hangs under and its follow-ups as one line each). Entry ids are full UUIDs; the user may paste one.",
					input: Schema.Struct({ id: Schema.optional(EntryId) }),
					options: { codemode: false },
					execute: tool((input: { id?: EntryId | undefined }, sessionID) => Effect.flatMap(root(sessionID), (session) => service.request("list", { session, id: input.id }))),
				});
			});

			// Sessions with the desk off don't see the tools at all.
			yield* ctx.session.hook("context", (event) =>
				Effect.map(Effect.orElseSucceed(on(event.sessionID), () => false), (desk) => {
					if (desk) return;
					for (const name of names) delete event.tools[name];
				}),
			);
		}),
});
