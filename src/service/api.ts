/**
 * What the service does for its clients: the plugin's requests (`protocol.ts`) and the page's views, in terms of
 * the desk and the sessions its desks belong to. The socket and the HTTP server only carry these.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Failures } from "../delivery";
import { Desk } from "../desk";
import { type Entry, type EntryId, SessionID, waitingFor } from "../entry";
import { DeskInUse, type Refusal } from "../errors";
import { OpenCode } from "../opencode";
import { type Draft, View } from "../page-api";
import type { PluginApi } from "../protocol";
import { deskPath, entryPath, link } from "../routes";
import { Sessions } from "../sessions";

const sameView = Schema.toEquivalence(View);

/** The plugin's request `Tag`, as `PluginApi` defines it. */
type Handler<Tag extends string, R = Rpc.ExtractTag<RpcGroup.Rpcs<typeof PluginApi>, Tag>> = (
	payload: Rpc.Payload<R>,
) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>;

export class Api extends Context.Service<
	Api,
	{
		readonly url: string;
		readonly ask: Handler<"ask">;
		readonly adopt: Handler<"adopt">;
		readonly answer: Handler<"answer">;
		readonly resolve: Handler<"resolve">;
		readonly prioritize: Handler<"prioritize">;
		readonly list: Handler<"list">;
		readonly page: Handler<"page">;
		readonly claim: Handler<"claim">;
		readonly view: (session: string | undefined) => Stream.Stream<View>;
		readonly submit: (drafts: ReadonlyArray<Draft>) => Effect.Effect<number, Refusal>;
		readonly send: (draft: Draft) => Effect.Effect<void, Refusal>;
		readonly resolveByUser: (id: EntryId) => Effect.Effect<void, Refusal>;
		readonly discard: (entry: EntryId) => Effect.Effect<void, Refusal>;
	}
>()("desk/Api") {
	/** Needs the page's `HttpServer`, for its URL (`http://127.0.0.1:<port>/`). */
	static get layer() {
		return Layer.effect(
			Api,
			Effect.gen(function* () {
				const server = yield* HttpServer.HttpServer;
				const url = server.address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${server.address.port}/`;
				const desk = yield* Desk;
				const sessions = yield* Sessions;
				const opencode = yield* OpenCode;
				const failures = yield* Failures;

				/** `session`'s desk: `session` is a top-level session's id (the page's URL). */
				const view = (session: string | undefined, entries: ReadonlyArray<Entry>) =>
					Effect.gen(function* () {
						const bySession = new Map<string, Array<Entry>>();
						for (const entry of entries) bySession.set(entry.session, [...(bySession.get(entry.session) ?? []), entry]);
						const name = (id: string, mine: ReadonlyArray<Entry>) =>
							Effect.map(
								// The folder its latest entry was asked from, for a session OpenCode doesn't know.
								sessions.name(SessionID.make(id), mine.at(-1)?.directory ?? ""),
								(name) => ({ session: id, ...name }),
							);
						const desks = yield* Effect.forEach(bySession, ([id, mine]) =>
							Effect.map(name(id, mine), (named) => {
								const waiting = waitingFor(mine, "user");
								return {
									...named,
									waiting: waiting.length,
									critical: waiting.filter((entry) => entry.priority === "critical").length,
								};
							}),
						);
						const all = {
							desks: desks.sort((a, b) => a.title.localeCompare(b.title) || a.folder.localeCompare(b.folder)),
							deskMode: yield* opencode.inDeskMode,
							failures: Object.fromEntries(yield* failures.current),
						};
						if (session === undefined) return { desk: null, entries: [], ...all } satisfies View;
						const mine = bySession.get(session) ?? [];
						const listed = desks.find((other) => other.session === session);
						return {
							desk: listed
								? { session, title: listed.title, folder: listed.folder, known: listed.known }
								: yield* name(session, mine),
							entries: mine,
							...all,
						} satisfies View;
					});

				return Api.of({
					url,
					ask: ({ asker, question }) =>
						Effect.map(desk.ask(asker, question), (entry) => ({
							id: entry.id,
							parent: entry.parent,
							url: link(url, entryPath(asker.session, entry.id)),
						})),
					adopt: ({ id, parent }) => Effect.asVoid(desk.adopt(id, parent)),
					answer: ({ id, body }) => Effect.asVoid(desk.answer(id, body)),
					resolve: ({ id }) => Effect.asVoid(desk.resolve(id, "agent")),
					prioritize: ({ id, priority, subtree }) => Effect.asVoid(desk.prioritize(id, priority, subtree)),
					list: ({ session, id }) => desk.describe(id, session),
					page: ({ session }) => Effect.succeed({ url: link(url, deskPath(session)) }),
					claim: ({ session, from }) =>
						Effect.gen(function* () {
							if ((yield* opencode.inDeskMode).includes(from)) return yield* new DeskInUse({ session: from });
							return yield* desk.claim(session, from);
						}),
					view: (session) =>
						Stream.mergeAll(
							[
								Stream.map(desk.changes, () => undefined),
								Stream.map(sessions.changes, () => undefined),
								Stream.map(failures.changes, () => undefined),
								Stream.map(opencode.deskMode, () => undefined),
							],
							{ concurrency: "unbounded" },
						).pipe(
							Stream.debounce("10 millis"),
							Stream.mapEffect(() => Effect.flatMap(desk.entries, (entries) => view(session, entries))),
							// The desk is read again every few seconds anyway: send a view only when it differs.
							Stream.changesWith(sameView),
						),
					submit: (drafts) => desk.reply(drafts, "queue"),
					send: (draft) => Effect.asVoid(desk.reply([draft], "steer")),
					resolveByUser: (id) => desk.resolve(id, "user"),
					discard: (id) => desk.discard(id),
				});
			}),
		);
	}
}
