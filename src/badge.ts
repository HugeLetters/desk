/**
 * What the TUI's footer badge shows (`tui.tsx`): per desk, how many entries wait on the user and how many
 * of those are critical, and where the page is. Read from the running service's page API (`view` without a session:
 * just the list of desks), found through its registration (`service-info.ts`). The badge doesn't start the
 * service (the server part does); while there's none, or after it goes, it looks again every couple of seconds.
 *
 * `watch` needs the platform's `FileSystem` and `Path`, an `HttpClient` and the RPC serialization: whoever runs it
 * provides them (the TUI's entry point, the tests).
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { DeskApi, DeskSummary } from "./page-api";
import { deskPath, link, rpcPath } from "./routes";
import * as ServiceInfo from "./service-info";

export const Status = Schema.Struct({
	/** The page, e.g. `http://127.0.0.1:47400/`. */
	url: Schema.String,
	desks: Schema.Array(DeskSummary),
	/** The top-level sessions in desk mode. */
	deskMode: Schema.Array(Schema.String),
});
export type Status = typeof Status.Type;
const sameStatus = Schema.toEquivalence(Schema.UndefinedOr(Status));

/** Why there's no status to show: no service is registered (or its page isn't up), another one replaced it, or it went. */
class NoService extends Data.TaggedError("NoService")<{ readonly reason: "unregistered" | "replaced" | "gone" }> {}

/** The running service's page, from its registration. */
const registered = (home: string) =>
	ServiceInfo.read(home).pipe(
		Effect.map(Option.flatMap((info) => Option.fromUndefinedOr(info.url))),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(new NoService({ reason: "unregistered" })),
				onSome: Effect.succeed,
			}),
		),
	);

/** One service's statuses, until it goes. Its RPC protocol is the one layer provided here: it's that service's URL. */
const from = (url: string) =>
	Stream.unwrap(Effect.map(RpcClient.make(DeskApi), (desk) => desk.view({}))).pipe(
		Stream.map((view): Status => ({ url, desks: view.desks, deskMode: view.deskMode })),
		Stream.provide(RpcClient.layerProtocolHttp({ url: link(url, rpcPath) })),
	);

/** Fails once the service at `url` is no longer the registered one (a stream from one that hangs might never end). */
const replaced = (home: string, url: string, every: Schedule.Schedule<unknown>) =>
	registered(home).pipe(
		Effect.orElseSucceed(() => undefined),
		Effect.repeat({ schedule: every, until: (now) => now !== url }),
		Effect.andThen(Effect.fail(new NoService({ reason: "replaced" }))),
	);

/** The desk's status, again after every change; `undefined` while no service answers. */
export const watch = (
	home: string,
	every: Schedule.Schedule<unknown> = Schedule.spaced("2 seconds"),
): Stream.Stream<
	Status | undefined,
	never,
	FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | RpcSerialization.RpcSerialization
> =>
	Stream.unwrap(
		Effect.map(registered(home), (url) => Stream.merge(from(url), Stream.fromEffect(replaced(home, url, every)))),
	).pipe(
		// A stream that ends means the service went too: look for the next one.
		Stream.concat(Stream.fail(new NoService({ reason: "gone" }))),
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
