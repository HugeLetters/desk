/**
 * What the service does for its clients' requests (`api.ts`), the page's and the plugins' alike, in terms of the desk
 * and the sessions its desks belong to. The RPC server (`rpc.ts`) only carries these, and the bridge into OpenCode.
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type DeskApi, party, View } from "../../api/api";
import { deskPath, entryPath, link, serviceUrl } from "../../api/routes";
import { type Entry, SessionID, waitingFor } from "../../model/entry";
import { DeskInUse } from "../../model/errors";
import { Failures } from "../delivery/delivery";
import { Desk } from "../desk";
import { OpenCode } from "../opencode/opencode";
import { Sessions } from "../opencode/sessions";

const sameView = Schema.toEquivalence(View);

/** The request `Tag`, as `DeskApi` defines it. */
type Handler<Tag extends string, R = Rpc.ExtractTag<RpcGroup.Rpcs<typeof DeskApi>, Tag>> = (
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
		readonly submit: Handler<"submit">;
		readonly send: Handler<"send">;
		readonly discard: Handler<"discard">;
	}
>()("desk/Api") {
	/** Needs the page's `HttpServer`, for its URL (`http://127.0.0.1:<port>/`). */
	static get layer() {
		return Layer.effect(
			Api,
			Effect.gen(function* () {
				const server = yield* HttpServer.HttpServer;
				const url = server.address._tag === "UnixPathAddress" ? "" : serviceUrl(server.address.port).href;
				const desk = yield* Desk;
				const sessions = yield* Sessions;
				const opencode = yield* OpenCode;
				const failures = yield* Failures;

				/** `session`'s desk: `session` is a top-level session's id (the page's URL). */
				const view = Effect.fn("view")(function* (session: string | undefined, entries: ReadonlyArray<Entry>) {
					const bySession = Arr.groupBy(entries, (entry): string => entry.session);
					const name = (id: string, mine: ReadonlyArray<Entry>) =>
						Effect.map(
							// The folder its latest entry was asked from, for a session OpenCode doesn't know.
							sessions.name(SessionID.make(id), mine.at(-1)?.directory ?? ""),
							(name) => ({ session: id, ...name }),
						);
					const deskMode = yield* opencode.inDeskMode;

					// A desk is a session's entries; a session in desk mode has one even before its first entry, so it's
					// listed from the start (empty), and one with unresolved entries stays listed after it leaves desk mode.
					const groups: ReadonlyArray<readonly [string, ReadonlyArray<Entry>]> = [
						...Object.entries(bySession),
						...deskMode.filter((id) => !(id in bySession)).map((id) => [id, []] as const),
					];
					const desks = yield* Effect.forEach(groups, ([id, mine]) =>
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
						deskMode,
						failures: Object.fromEntries(yield* failures.current),
					};
					if (session === undefined) return { desk: null, entries: [], ...all } satisfies View;

					const mine: ReadonlyArray<Entry> = bySession[session] ?? [];
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
					ask: ({ by, question }) =>
						Effect.map(desk.ask(by, question), (entry) => ({
							id: entry.id,
							parent: entry.parent,
							url: link(url, entryPath(by.session, entry.id)),
						})),
					adopt: ({ id, parent }) => Effect.asVoid(desk.adopt(id, parent)),
					answer: ({ id, body }) => Effect.asVoid(desk.answer(id, body)),
					resolve: ({ by, id }) => desk.resolve(id, party(by)),
					prioritize: ({ id, priority, subtree }) => Effect.asVoid(desk.prioritize(id, priority, subtree)),
					list: ({ session, id }) => desk.describe(id, session),
					page: ({ session }) => Effect.succeed({ url: link(url, deskPath(session)) }),
					claim: Effect.fnUntraced(function* ({ by, from }) {
						if ((yield* opencode.inDeskMode).includes(from)) return yield* new DeskInUse({ session: from });
						return yield* desk.claim(by.session, from);
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
					submit: ({ drafts }) => desk.reply(drafts, "queue"),
					send: (draft) => Effect.asVoid(desk.reply([draft], "steer")),
					discard: ({ entry }) => desk.discard(entry),
				});
			}),
		);
	}
}
