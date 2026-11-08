/**
 * What the service does for its clients: the plugin's requests (`protocol.ts`) and the page's views, in terms of
 * the desk and the projects its entries belong to. The socket and the HTTP server only carry these.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Desk, type Draft } from "../desk";
import { type Entry, waitingFor } from "../entry";
import type { DeskError } from "../errors";
import { unknownProject, type View } from "../page-api";
import { Projects } from "../projects";
import type { Methods } from "../protocol";

type Handler<M extends keyof Methods> = (input: Methods[M]["input"]) => Effect.Effect<Methods[M]["output"], DeskError>;

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
		readonly submit: (drafts: ReadonlyArray<Draft>) => Effect.Effect<number, DeskError>;
		readonly send: (draft: Draft) => Effect.Effect<void, DeskError>;
		readonly resolveByUser: (id: string) => Effect.Effect<void, DeskError>;
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
				const link = (project: string | undefined, entry?: string) => `${url}?project=${encodeURIComponent(project ?? unknownProject)}${entry ? `#/${entry}` : ""}`;

				/** Each entry's project, by root session (one lookup per session). */
				const placed = (entries: ReadonlyArray<Entry>) =>
					Effect.gen(function* () {
						const bySession = new Map<string, string>();
						for (const session of new Set(entries.map((entry) => entry.session))) bySession.set(session, (yield* projects.of(session)) ?? unknownProject);
						return (entry: Entry) => bySession.get(entry.session)!;
					});
				/** Entries in the same project as `session`. */
				const scope = (session: string) =>
					Effect.gen(function* () {
						const project = (yield* projects.of(session)) ?? unknownProject;
						const projectOf = yield* placed(yield* desk.entries);
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
								const name = id === unknownProject ? "Unknown project" : yield* projects.name(id, mine[0]?.directory);
								return { id, name, waiting: waiting.length, critical: waiting.filter((entry) => entry.priority === "critical").length };
							}),
						);
						const name = project === undefined ? undefined : (summaries.find((summary) => summary.id === project)?.name ?? (yield* projects.name(project)));
						return {
							project: project === undefined ? null : { id: project, name: name! },
							entries: project === undefined ? [] : entries.filter((entry) => projectOf(entry) === project),
							projects: summaries.sort((a, b) => a.name.localeCompare(b.name)),
						} satisfies View;
					});

				return Api.of({
					url,
					ask: ({ asker, question }) =>
						Effect.gen(function* () {
							const { project, scope: mine } = yield* scope(asker.session);
							const entry = yield* desk.ask(asker, question, mine);
							return { id: entry.id, parent: entry.parent, url: link(project, entry.id) };
						}),
					adopt: ({ id, parent }) => Effect.as(desk.adopt(id, parent), null),
					answer: ({ id, body }) => Effect.as(desk.answer(id, body), null),
					resolve: ({ id }) => Effect.as(desk.resolve(id, "agent"), null),
					prioritize: ({ id, priority, subtree }) => Effect.as(desk.prioritize(id, priority, subtree), null),
					list: ({ session, id }) => Effect.flatMap(scope(session), ({ scope: mine }) => desk.describe(id, mine)),
					page: ({ session }) => Effect.map(projects.of(session), (project) => ({ url: link(project) })),
					view: (project) =>
						Stream.mergeAll([Stream.map(desk.changes, () => undefined), Stream.map(projects.changes, () => undefined)], { concurrency: "unbounded" }).pipe(
							Stream.debounce("10 millis"),
							Stream.mapEffect(() => Effect.flatMap(desk.entries, (entries) => view(project, entries))),
						),
					submit: (drafts) => desk.reply(drafts, "queue"),
					send: (draft) => Effect.asVoid(desk.reply([draft], "steer")),
					resolveByUser: (id) => desk.resolve(id, "user"),
				});
			}),
		);
	}
}
