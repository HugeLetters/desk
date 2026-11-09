/**
 * What the service does for its clients: the plugin's requests (`protocol.ts`) and the page's views, in terms of
 * the desk and the projects its entries belong to. The socket and the HTTP server only carry these.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { Desk } from "../desk";
import { Failures } from "../delivery";
import { type Entry, type EntryId, type SessionID, waitingFor } from "../entry";
import type { Refusal } from "../errors";
import type { Draft, View } from "../page-api";
import { guessed, Projects } from "../projects";
import { OpenCode } from "../opencode";
import type { PluginApi } from "../protocol";

/** The plugin's request `Tag`, as `PluginApi` defines it. */
type Handler<Tag extends string, R = Rpc.ExtractTag<RpcGroup.Rpcs<typeof PluginApi>, Tag>> = (payload: Rpc.Payload<R>) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>;

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
		readonly view: (project: string | undefined) => Stream.Stream<View>;
		readonly submit: (drafts: ReadonlyArray<Draft>) => Effect.Effect<number, Refusal>;
		readonly send: (draft: Draft) => Effect.Effect<void, Refusal>;
		readonly resolveByUser: (id: EntryId) => Effect.Effect<void, Refusal>;
		readonly discard: (entry: EntryId) => Effect.Effect<void, Refusal>;
	}
>()("desk/Api") {
	/** Needs the page's `HttpServer`, for its URL (`http://127.0.0.1:<port>/`). */
	static get layer() {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const server = yield* HttpServer.HttpServer;
				const url = server.address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${server.address.port}/`;
				const desk = yield* Desk;
				const projects = yield* Projects;
				const opencode = yield* OpenCode;
				const failures = yield* Failures;
				const link = (project: string, entry?: string) => `${url}projects/${encodeURIComponent(project)}${entry ? `/questions/${entry}` : ""}`;

				/** Each entry's project (one lookup per root session; `Projects` remembers them). */
				const placed = (entries: ReadonlyArray<Entry>) =>
					Effect.gen(function* () {
						const byEntry = new Map<string, string>();
						for (const entry of entries) byEntry.set(entry.id, yield* projects.of(entry));
						return (entry: Entry) => byEntry.get(entry.id)!;
					});
				/** Entries in the same project as `session` (working in `directory`, when known). */
				const scope = (session: SessionID, directory?: string) =>
					Effect.gen(function* () {
						const all = yield* desk.entries;
						const where = directory ?? all.find((entry) => entry.session === session)?.directory ?? "";
						const project = yield* projects.of({ session, directory: where });
						const projectOf = yield* placed(all);
						return { project, scope: (entry: Entry) => projectOf(entry) === project };
					});

				const view = (project: string | undefined, entries: ReadonlyArray<Entry>) =>
					Effect.gen(function* () {
						const projectOf = yield* placed(entries);
						const ids = [...new Set(entries.map(projectOf))];
						const summaries = yield* Effect.forEach(ids, (id) =>
							Effect.gen(function* () {
								const mine = entries.filter((entry) => projectOf(entry) === id);
								const waiting = waitingFor(mine, "user");
								const name = yield* projects.name(id, mine[0]?.directory);
								return { id, name, guessed: guessed(id), waiting: waiting.length, critical: waiting.filter((entry) => entry.priority === "critical").length };
							}),
						);
						const name = project === undefined ? undefined : (summaries.find((summary) => summary.id === project)?.name ?? (yield* projects.name(project)));
						return {
							project: project === undefined ? null : { id: project, name: name!, guessed: guessed(project) },
							entries: project === undefined ? [] : entries.filter((entry) => projectOf(entry) === project),
							projects: summaries.sort((a, b) => a.name.localeCompare(b.name)),
							opencode: yield* opencode.connected,
							deskMode: yield* opencode.inDeskMode,
							failures: Object.fromEntries(yield* failures.current),
						} satisfies View;
					});

				return Api.of({
					url,
					ask: ({ asker, question }) =>
						Effect.gen(function* () {
							const { project, scope: mine } = yield* scope(asker.session, asker.directory);
							const entry = yield* desk.ask(asker, question, mine);
							return { id: entry.id, parent: entry.parent, url: link(project, entry.id) };
						}),
					adopt: ({ id, parent }) => Effect.asVoid(desk.adopt(id, parent)),
					answer: ({ id, body }) => Effect.asVoid(desk.answer(id, body)),
					resolve: ({ id }) => Effect.asVoid(desk.resolve(id, "agent")),
					prioritize: ({ id, priority, subtree }) => Effect.asVoid(desk.prioritize(id, priority, subtree)),
					list: ({ session, id }) => Effect.flatMap(scope(session), ({ scope: mine }) => desk.describe(id, mine)),
					page: ({ session }) => Effect.map(scope(session), ({ project }) => ({ url: link(project) })),
					view: (project) =>
						Stream.mergeAll([Stream.map(desk.changes, () => undefined), Stream.map(projects.changes, () => undefined), Stream.map(failures.changes, () => undefined), Stream.map(opencode.deskMode, () => undefined)], { concurrency: "unbounded" }).pipe(
							Stream.debounce("10 millis"),
							Stream.mapEffect(() => Effect.flatMap(desk.entries, (entries) => view(project, entries))),
							// The desk is read again every few seconds anyway: send a view only when it differs.
							Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
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
