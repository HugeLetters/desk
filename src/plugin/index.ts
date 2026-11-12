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
 * `~/.local/share/desk`), `port` (the page's preferred port, default `$DESK_PORT` or 47400; any free one when it's taken)
 * and `timeout` (how long a desk call may take before the agent is told the service seems stuck; default 30 seconds).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { flow } from "effect";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EntryId, Priority, SessionID } from "../entry";
import { Refusal } from "../errors";
import type { Question } from "../protocol";
import { refusal } from "../wording";
import * as Connection from "./connection";

const media =
	"Markdown: text, code fences, ```mermaid diagrams, images and GIFs (![alt](path)), video (![alt](clip.mp4)). Link files by path relative to the session's directory, e.g. ![icon](design/icons/01.png).";

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description });

const isRefusal = Schema.is(Refusal);

/** Whether `error` is OpenCode saying it doesn't know the session. */
const notFound = (error: unknown) =>
	// TODO main | just define a schema - or use one if opencode exports it already | by Evgenii Perminov at Thu, 12 Nov 2026 18:52:06 GMT
	typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError";

// TODO main | a lot of stuff is bundled in plugin which makes it hard to follow | by Evgenii Perminov at Thu, 12 Nov 2026 18:51:50 GMT
export default Plugin.define({
	id: "desk",
	effect: (ctx) =>
		Effect.gen(function* () {
			const home = String(ctx.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk")).replace(
				/^~(?=\/|$)/,
				homedir(),
			);
			const port = String(ctx.options.port ?? process.env.DESK_PORT ?? 47400);
			const timeout = yield* parseTimeout(ctx.options.timeout);

			/** The sessions in desk mode in this plugin instance's directory (`on/<id>` in the plugin's storage), forgetting deleted ones. */
			const modes = Effect.gen(function* () {
				const sessions = yield* Stream.paginate(undefined as string | undefined, (after) =>
					Effect.map(ctx.storage.scan({ prefix: "on/", after }), (page) => [
						page.entries.map((entry) => SessionID.make(entry.key.slice("on/".length))),
						Option.fromUndefinedOr(page.next),
					]),
				).pipe(Stream.runCollect);
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
				directory: ctx.location.directory,
				modes,
				serve: {
					session: (sessionID) =>
						ctx.session.get({ sessionID }).pipe(
							Effect.map((session) => ({
								id: session.id,
								parentID: session.parentID ?? undefined,
								title: session.title ?? "",
								directory: session.location.directory,
							})),
							// Not this OpenCode's session; anything else is an error the service retries.
							Effect.catchIf(notFound, () => Effect.succeed(null)),
						),
					prompt: ({ sessionID, id, text, delivery, files }) =>
						Effect.asVoid(
							ctx.session.prompt({
								sessionID,
								id,
								text,
								delivery,
								files: files.map((file) => ({ uri: file.uri, name: file.name })),
							}),
						),
				},
			};

			// Connected (and so starting the service) only while a session in this directory is in desk mode: the page
			// counts those sessions, and a plugin instance with none has nothing to ask or deliver.
			const lock = yield* Semaphore.make(1);
			const connection = yield* Connection.make(options);
			/**
			 * Connects, reports the sessions in desk mode, or hangs up, to match the storage. Connecting reports them itself
			 * (`attach` reads them), so only a live connection is told.
			 */
			const sync = Semaphore.withPermits(
				lock,
				1,
			)(
				Effect.gen(function* () {
					const mine = yield* modes;
					if (mine.length === 0) return yield* connection.want(false);
					const live = yield* connection.live;
					if (Option.isSome(live)) yield* Effect.ignore(live.value.modes({ sessions: mine }));
					else yield* connection.want(true);
				}),
			);
			yield* sync;
			/** Runs `f` against the service, while this instance is connected. */
			const service = <A, E>(f: (client: Connection.Client) => Effect.Effect<A, E>) =>
				Effect.flatMap(connection.client, f);
			// A session that moves keeps its desk; the service looks its folder up again, for the desk's name.
			yield* ctx.event.subscribe({ types: ["session.moved"] }).pipe(
				// A session moving in or out of this directory may connect or hang up this instance, too.
				Stream.runForEach((event) =>
					Effect.andThen(Effect.ignore(service((client) => client.moved({ session: event.data.sessionID }))), sync),
				),
				Effect.ignore,
				Effect.forkScoped,
			);

			/**
			 * A session's top-level session: a subagent's desk is its parent's. Parents never change, so it's cached; a
			 * failed lookup isn't (OpenCode may answer next time).
			 */
			const roots: Cache.Cache<SessionID, SessionID, unknown> = yield* Cache.makeWith(
				(sessionID: SessionID) =>
					ctx.session
						.get({ sessionID })
						.pipe(
							Effect.flatMap((session) =>
								session.parentID ? Cache.get(roots, session.parentID) : Effect.succeed(session.id),
							),
						),
				{ capacity: 10_000, timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero) },
			);
			const root = (sessionID: SessionID) => Cache.get(roots, sessionID);
			const key = (rootID: SessionID) => `on/${rootID}`;
			const on = flow(
				root,
				Effect.map(key),
				Effect.flatMap(ctx.storage.get),
				Effect.map((value) => value === true),
			);

			/**
			 * A desk call takes milliseconds; one still running after `timeout` means the service is stuck, and the agent
			 * (or the user, for /desk-mode) hears so instead of waiting for good.
			 */
			const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.timeoutOrElse(effect, {
					duration: timeout,
					orElse: () =>
						Effect.fail(
							new Error(
								`The desk service didn't answer within ${Duration.format(timeout)}; it may be stuck. The user can restart it: kill the pid in ${join(home, "service.json")}.`,
							),
						),
				});

			const names = [
				"desk_ask",
				"desk_adopt",
				"desk_answer",
				"desk_resolve",
				"desk_prioritize",
				"desk_list",
				"desk_claim",
			];
			/** Runs a tool for a session with the desk on; any failure reaches the model as the tool's error. */
			const tool =
				<I, E>(run: (input: I, sessionID: SessionID) => Effect.Effect<string, E>) =>
				(input: I, context: Tool.Context) =>
					Effect.gen(function* () {
						if (!(yield* on(context.sessionID))) {
							return yield* new Tool.Error({
								message: "The desk is off for this session; the user turns it on with /desk-mode.",
							});
						}

						return { content: yield* run(input, context.sessionID) };
					}).pipe(
						within,
						Effect.mapError((error) =>
							error instanceof Tool.Error
								? error
								: new Tool.Error({
										message: isRefusal(error) ? refusal(error) : Connection.errorMessage(error),
									}),
						),
					);

			yield* ctx.command.transform((editor) => {
				editor.add({
					name: "desk-mode",
					description:
						"Turn desk mode on or off for this session: agents ask you questions on the desk instead of in chat",
					execute: ({ sessionID }) =>
						Effect.gen(function* () {
							const rootID = yield* root(sessionID);
							const now = (yield* ctx.storage.get(key(rootID))) !== true;
							if (now) yield* ctx.storage.set(key(rootID), true);
							else yield* ctx.storage.remove(key(rootID));
							yield* sync;
							const url = now ? (yield* service((client) => client.page({ session: rootID }))).url : undefined;
							const text = url
								? `Desk mode is on for this session. What you need from the user and what you tell them goes on the desk (desk_ask), not in chat, for this session and its subagents: in chat, questions and answers get lost as they come in out of order. That's every question, decision or review, and your replies too: to what they said on the desk (a follow-up under that entry) and to what they ask in chat, unless they ask for the reply in chat. In chat, name an entry by its title at most (a critical one, say); don't retell it there. The user answers on <${url}>\n`
								: "Desk mode is off for this session: the desk_* tools are gone; ask the user in chat.";
							// The TUI shows a synthetic message by its description only (none: not at all); the text is for the agent.
							const description = url ? `Desk mode on: ${url}` : "Desk mode off";
							yield* ctx.session.synthetic({ sessionID, text, description, resume: false });
						}).pipe(within),
				});
			});

			yield* ctx.tool.transform((editor) => {
				editor.add({
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
							const session = yield* ctx.session.get({ sessionID: (yield* root(sessionID)) as never });
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
				});
				editor.add({
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
				});
				editor.add({
					name: "desk_answer",
					description: "Answer a question the user asked on the desk. Markdown, as in desk_ask.",
					input: Schema.Struct({ id: EntryId, body: described(Schema.String, "The answer, in Markdown.") }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId; body: string }) =>
						service((client) => client.answer(input)).pipe(Effect.as(`Answered ${input.id}.`)),
					),
				});
				editor.add({
					name: "desk_resolve",
					description:
						"Mark one of your own desk questions done, once its outcome is applied (glossary, ADR, issue, code). Refused while anything below it is unresolved (the error lists those ids): resolve or wait for them first. Resolved entries without open follow-ups leave the desk.",
					input: Schema.Struct({ id: EntryId }),
					options: { codemode: false },
					execute: tool((input: { id: EntryId }) =>
						service((client) => client.resolve(input)).pipe(Effect.as(`Resolved ${input.id}.`)),
					),
				});
				editor.add({
					name: "desk_prioritize",
					description:
						"Change an entry's priority (critical, high, normal, low): the user sees higher priority first, e.g. bump a main PR's review thread. With subtree, the entry and everything below it.",
					input: Schema.Struct({ id: EntryId, priority: Priority, subtree: Schema.optional(Schema.Boolean) }),
					// Rarely needed: in Code Mode, out of every request's tool list (`desk_ask` names it).
					options: { codemode: true },
					execute: tool((input: { id: EntryId; priority: Priority; subtree?: boolean | undefined }) =>
						service((client) =>
							client.prioritize({ id: input.id, priority: input.priority, subtree: input.subtree ?? false }),
						).pipe(
							Effect.as(`Set ${input.id} to ${input.priority}${input.subtree ? " (with everything below it)" : ""}.`),
						),
					),
				});
				editor.add({
					name: "desk_list",
					description:
						"Show this session's desk (its subagents share it): every unresolved entry, one line each (id, title, [status, whose turn, priority, from the user]), or one entry in full when id is given (with the entries it hangs under and its follow-ups as one line each). Entry ids are full UUIDs; the user may paste one.",
					input: Schema.Struct({ id: Schema.optional(EntryId) }),
					options: { codemode: false },
					execute: tool((input: { id?: EntryId | undefined }, sessionID) =>
						Effect.flatMap(root(sessionID), (session) => service((client) => client.list({ session, id: input.id }))),
					),
				});
				editor.add({
					name: "desk_claim",
					description:
						"Take over another session's desk: every entry of that session (open questions, undelivered answers) becomes this session's, so this session can list, answer and resolve them, and their answers come here. For a desk left by a session that's gone (the page shows it as unknown). Refused while that session is in desk mode.",
					input: Schema.Struct({ from: described(SessionID, "The session whose desk to take over (ses_…).") }),
					// Rarely needed: in Code Mode, out of every request's tool list (`desk_ask` names it).
					options: { codemode: true },
					execute: tool((input: { from: SessionID }, sessionID) =>
						Effect.flatMap(root(sessionID), (session) =>
							service((client) => client.claim({ session, from: input.from })).pipe(
								Effect.map(
									(count) => `Claimed ${count} ${count === 1 ? "entry" : "entries"} from ${input.from}'s desk.`,
								),
							),
						),
					),
				});
			});

			// Sessions with the desk off don't see the tools at all.
			// TODO main | there must be a cleaner way to do this - just register/unregister tools depending on whether its on | by Evgenii Perminov at Thu, 12 Nov 2026 18:53:11 GMT
			yield* ctx.session.hook("context", (event) =>
				Effect.map(
					Effect.orElseSucceed(on(event.sessionID), () => false),
					(desk) => {
						if (desk) return;
						for (const name of names) delete event.tools[name];
					},
				),
			);
		}),
});

function parseTimeout(timeout: unknown) {
	const fallbackTimeout = Duration.seconds(30);

	return Schema.decodeUnknownEffect(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]))(timeout).pipe(
		Effect.tapError(() =>
			Effect.logWarning(
				`desk: the timeout option isn't a duration (${timeout}); using ${Duration.format(fallbackTimeout)}`,
			),
		),
		Effect.orElseSucceed(() => fallbackTimeout),
	);
}
