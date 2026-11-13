/**
 * What the TUI's footer badge shows (`tui.tsx`): per desk, how many entries wait on the user and how many
 * of those are critical, and where the page is. Read from the service's API (`view` without a session: just the list
 * of desks), over a WebSocket to the port setting's `/rpc`, where the page is too. The badge doesn't start the
 * service (the server part does); while none answers there, or after it goes, it tries again every couple of seconds.
 *
 * `watch` needs the RPC serialization: whoever runs it provides it (the TUI's entry point, the tests).
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { DeskApi, DeskSummary } from "../api/api";
import { deskPath, link, rpcPath } from "../api/routes";

export const Status = Schema.Struct({
	/** The page, e.g. `http://127.0.0.1:47400/`. */
	url: Schema.String,
	desks: Schema.Array(DeskSummary),
	/** The top-level sessions in desk mode. */
	deskMode: Schema.Array(Schema.String),
});
export type Status = typeof Status.Type;
const sameStatus = Schema.toEquivalence(Schema.UndefinedOr(Status));

/** The service's stream ended: it went. */
class Gone extends Data.TaggedError("Gone") {}

/** The page of the service on `port`. */
export const page = (port: number) => `http://127.0.0.1:${port}/`;

/** The service's statuses, until it goes. Its RPC protocol is the one layer provided here: it's that service's. */
const from = (url: string) =>
	Stream.unwrap(Effect.map(RpcClient.make(DeskApi), (desk) => desk.view({}))).pipe(
		Stream.map((view): Status => ({ url, desks: view.desks, deskMode: view.deskMode })),
		Stream.provide(
			RpcClient.layerProtocolSocket().pipe(
				Layer.provide(BunSocket.layerWebSocket(link(url, rpcPath).replace(/^http/, "ws"))),
			),
		),
	);

/** The desk's status on `port`, again after every change; `undefined` while no service answers there. */
export const watch = (
	port: number,
	every: Schedule.Schedule<unknown> = Schedule.spaced("2 seconds"),
): Stream.Stream<Status | undefined, never, RpcSerialization.RpcSerialization> =>
	from(page(port)).pipe(
		// A stream that ends means the service went too: look for the next one.
		Stream.concat(Stream.fail(new Gone())),
		// Whatever the reason, nothing to show until the next one answers.
		Stream.catch((error) => Stream.concat(Stream.make(undefined), Stream.fail(error))),
		Stream.retry(every),
		Stream.orDie,
		Stream.changesWith(sameStatus),
	);

/** The footer's count for a desk: none when nothing waits on the user, else how many do and how many of those are critical. */
export const count = (summary: DeskSummary | undefined) =>
	summary === undefined || summary.waiting === 0 ? undefined : { waiting: summary.waiting, critical: summary.critical };

/** What the badge shows for one desk: where its page is, and its count. */
export interface Report {
	readonly page: string;
	readonly count: ReturnType<typeof count>;
}

/** The badge for `desk` (a top-level session): none unless a service answers and the session is in desk mode. */
export const report = (status: Status | undefined, desk: string | undefined): Report | undefined =>
	status === undefined || desk === undefined || !status.deskMode.includes(desk)
		? undefined
		: {
				page: link(status.url, deskPath(desk)),
				count: count(status.desks.find((summary) => summary.session === desk)),
			};
