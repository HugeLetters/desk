/**
 * What this plugin instance tells the TUI's badge (`badge-rpc.ts`): a session's desk, from the service's `view` on the
 * live connection (without a session: just the desks' summary), while that desk is in desk mode; else nothing. Nothing
 * of its own: the connection follows desk mode (`modes.ts`) and the service's restarts, and so does this.
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { View } from "../api/api";
import { deskPath, link } from "../api/routes";
import type { SessionID } from "../model/entry";
import { BadgeRpc } from "./badge-rpc";
import type { Connection, Link } from "./connection";
import type { Modes } from "./modes";
import type * as Sessions from "./sessions";

/** What the live link's service last said: its page and its view. */
export interface Seen {
	readonly url: URL;
	readonly view: View;
}

/** The badge of the desk of `root` (a top-level session in desk mode), out of what the service last said. */
export const fromView = ({ url, view }: Seen, root: SessionID) => {
	const desk = view.desks.find((summary) => summary.session === root);
	return { page: link(url, deskPath(root)), waiting: desk?.waiting ?? 0, critical: desk?.critical ?? 0 };
};

/** The link's views, for as long as it lasts: none until the service's first, and once it ends. */
const linkViews = (link: Link) =>
	link.client.view({}).pipe(
		Stream.map((view) => Option.some<Seen>({ url: link.url, view })),
		Stream.catchCause(() => Stream.empty),
		Stream.concat(Stream.make(Option.none<Seen>())),
	);

/** What the service says now, then every change: each live link's views, none between them. */
export const seen = (connection: Pick<Connection, "links">) =>
	connection.links.pipe(
		Stream.switchMap(Option.match({ onNone: () => Stream.make(Option.none<Seen>()), onSome: linkViews })),
	);

export interface Options {
	readonly connection: Pick<Connection, "links">;
	readonly modes: Pick<Modes, "on">;
	readonly getRootSessionId: (sessionID: SessionID) => Effect.Effect<SessionID, Sessions.Failure>;
}

/**
 * Registers the badge's RPC in this plugin instance, until the scope closes: `status` answers from the service's
 * latest view, and `changed` goes out with each new one and whenever the connection comes or goes.
 */
export const register = Effect.fn("register")(function* (ctx: Pick<Plugin.Context, "rpc">, options: Options) {
	const latest = yield* SubscriptionRef.make(Option.none<Seen>());

	const registration = yield* ctx.rpc.register(BadgeRpc, {
		status: Effect.fnUntraced(
			function* ({ session }, _call) {
				const root = yield* options.getRootSessionId(session);
				if (!(yield* options.modes.on(root))) return null;

				return Option.match(yield* SubscriptionRef.get(latest), {
					onNone: () => null,
					onSome: (now) => fromView(now, root),
				});
			},
			// Not OpenCode's session: no desk, so no badge. OpenCode failing otherwise: the TUI asks again.
			Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)),
			(effect, _input, call) =>
				Effect.catchTag(effect, "OpenCodeError", (failure) => Effect.fail(call.error("opencode", failure.message, {}))),
		),
	});

	yield* seen(options.connection).pipe(
		Stream.runForEach((now) =>
			Effect.andThen(SubscriptionRef.set(latest, now), Effect.ignore(registration.events.emit("changed", {}))),
		),
		Effect.forkScoped,
	);
});
