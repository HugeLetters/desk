/**
 * What the TUI's footer badge shows (`tui.tsx`): per project on the desk, how many entries wait on the user and how many
 * of those are critical, and where the page is. Read from the running service's page API (`view` without a project:
 * just the project list), found through its registration (`<store>/service.json`). The badge doesn't start the
 * service (the server part does); while there's none, or after it goes, it looks again every couple of seconds.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { DeskApi, type ProjectSummary } from "./page-api";

export interface Status {
	/** The page, e.g. `http://127.0.0.1:47400/`. */
	readonly url: string;
	readonly projects: ReadonlyArray<ProjectSummary>;
	/** The top-level sessions in desk mode. */
	readonly deskMode: ReadonlyArray<string>;
}

/** The running service's page, from its registration. */
const registered = (home: string) =>
	Effect.tryPromise(() => readFile(join(home, "service.json"), "utf8")).pipe(Effect.map((text) => String(JSON.parse(text).url)));

/** One service's statuses, until it goes. */
const from = (url: string): Stream.Stream<Status, unknown> =>
	Stream.unwrap(Effect.map(RpcClient.make(DeskApi), (desk) => desk.view({}))).pipe(
		Stream.map((view) => ({ url, projects: view.projects, deskMode: view.deskMode })),
		Stream.provide(RpcClient.layerProtocolHttp({ url: `${url}rpc` }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))),
	);

/** Fails once the service at `url` is no longer the registered one (a stream from one that hangs might never end). */
const replaced = (home: string, url: string, every: Schedule.Schedule<unknown>) =>
	registered(home).pipe(
		Effect.orElseSucceed(() => undefined),
		Effect.repeat({ schedule: every, until: (now) => now !== url }),
		Effect.andThen(Effect.fail("replaced")),
	);

/** The desk's status, again after every change; `undefined` while no service answers. */
export const watch = (home: string, every: Schedule.Schedule<unknown> = Schedule.spaced("2 seconds")): Stream.Stream<Status | undefined> =>
	Stream.unwrap(Effect.map(registered(home), (url) => Stream.merge(from(url), Stream.fromEffect(replaced(home, url, every))))).pipe(
		// A stream that ends means the service went too: look for the next one.
		Stream.concat(Stream.fail("gone")),
		Stream.catch(() => Stream.concat(Stream.make(undefined), Stream.fail("retry"))),
		Stream.retry(every),
		Stream.orDie,
		Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
	);

/** The footer's count for a project: none when nothing waits on the user, else how many do and how many of those are critical. */
export const count = (summary: ProjectSummary | undefined) =>
	summary === undefined || summary.waiting === 0 ? undefined : { waiting: summary.waiting, critical: summary.critical };
