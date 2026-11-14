/**
 * What this plugin instance tells the TUI's badge (`badge-rpc.ts`): while its connection is live, the desks' summary
 * from the service's `view` (without a session: just the list of desks), on that same connection; else not connected.
 * Nothing of its own: the connection follows desk mode (`modes.ts`) and the service's restarts, and so does this.
 */
import type { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { View } from "../api/api";
import { BadgeRpc, off, type Status, sameStatus } from "./badge-rpc";
import type { Connection, Link } from "./connection";

/** The badge's status out of the service's `view`. */
export const fromView = (url: string, view: View): Status => ({
	live: {
		url,
		desks: view.desks.map(({ session, waiting, critical }) => ({ session, waiting, critical })),
		deskMode: view.deskMode,
	},
});

/** The link's statuses, for as long as it lasts: not connected until the service's first view, and once it ends. */
const over = (link: Link): Stream.Stream<Status> =>
	link.client.view({}).pipe(
		Stream.map((view) => fromView(link.url, view)),
		Stream.catchCause(() => Stream.empty),
		Stream.concat(Stream.make(off)),
	);

/** The status now, then every change: each live link's views, not connected between them. */
export const statuses = (connection: Pick<Connection, "links">): Stream.Stream<Status> =>
	connection.links.pipe(
		Stream.switchMap(Option.match({ onNone: () => Stream.make(off), onSome: over })),
		Stream.changesWith(sameStatus),
	);

/** Registers the badge's RPC in this plugin instance, answering `status` and emitting `changed`, until the scope closes. */
export const register = (ctx: Pick<Plugin.Context, "rpc">, connection: Pick<Connection, "links">) =>
	Effect.gen(function* () {
		const current = yield* SubscriptionRef.make(off);
		const registration = yield* ctx.rpc.register(BadgeRpc, { status: () => SubscriptionRef.get(current) });
		yield* statuses(connection).pipe(
			Stream.runForEach((status) =>
				Effect.flatMap(SubscriptionRef.getAndSet(current, status), (before) =>
					sameStatus(before, status) ? Effect.void : Effect.ignore(registration.events.emit("changed", status)),
				),
			),
			Effect.forkScoped,
		);
	});
