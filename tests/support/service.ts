/**
 * A desk service in this process, on a temporary store, a free port and fake OpenCode servers. Plugin instances
 * reach it the way the plugin does (`plugin/connection.ts`); pages through the typed RPC client, as the page does.
 * Both over the WebSocket at `/rpc`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { DeskApi } from "../../src/api/api";
import { link, rpcPath } from "../../src/api/routes";
import { Refusal } from "../../src/model/errors";
import { refusal } from "../../src/model/wording";
import * as Connection from "../../src/plugin/connection";
import * as App from "../../src/service/app";
import { Clients } from "../../src/service/clients";
import { OpenCode } from "../../src/service/opencode/opencode";
import { Api } from "../../src/service/transport/api";
import { type FakeServer, fakeOpenCode } from "./fake-opencode";

export type Service = Awaited<ReturnType<typeof startService>>;

type Request = Exclude<keyof Connection.Client, "hello" | "attach" | "reply">;
type Answer<Tag extends Request> = Effect.Success<ReturnType<Connection.Client[Tag]>>;
const isRefusal = Schema.is(Refusal);

export async function startService(
	options: {
		store?: string;
		idle?: number;
		/** Default: any free one. */
		port?: number;
		fake?: ReturnType<typeof fakeOpenCode>;
		outdated?: Effect.Effect<boolean, never, FileSystem.FileSystem>;
	} = {},
) {
	const store = options.store ?? (await mkdtemp(join(tmpdir(), "desk-")));
	const fake = options.fake ?? fakeOpenCode();
	const scope = Effect.runSync(Scope.make());
	const services = (await Effect.runPromise(
		Layer.buildWithScope(
			App.layer({
				store,
				port: options.port ?? 0,
				idle: options.idle ?? 60_000,
				retry: "50 millis",
				outdated: options.outdated ?? Effect.succeed(false),
			}).pipe(Layer.provideMerge(BunServices.layer)),
			scope,
		),
	)) as Context.Context<Api | Clients | OpenCode>;
	const url = Context.get(services, Api).url;
	const port = Number(new URL(url).port);
	const plugins: Array<Scope.Closeable> = [];
	const unwatch: Array<() => void> = [];
	let blank = 0;

	return {
		store,
		url,
		port,
		fake,
		services,
		/** A plugin instance in the OpenCode `opencode` (default: one that knows no sessions), in `directory`. */
		plugin(opencode: FakeServer = fake.server(`blank-${++blank}`), directory = "/work/default") {
			const held = Effect.runSync(Scope.make());
			const live = Effect.runSync(
				Scope.provide(
					Connection.make({
						port,
						start: Effect.void,
						directory,
						modes: Effect.sync(() => [...opencode.sessions.keys()]),
						serve: fake.serve(opencode),
						timeout: 1000,
						wanted: true,
					}),
					held,
				),
			);
			const connection = {
				/** A request to the service, as the plugin makes it; a refusal rejects with its wording. */
				request: <Tag extends Request>(
					method: Tag,
					input: Parameters<Connection.Client[Tag]>[0],
				): Promise<Answer<Tag>> =>
					Effect.runPromise(
						Effect.flatMap(live.client, (client) =>
							(client[method] as (input: unknown) => Effect.Effect<Answer<Tag>, unknown>)(input),
						).pipe(Effect.mapError((error) => (isRefusal(error) ? new Error(refusal(error)) : error))),
					),
				url: () => Effect.runPromise(live.url),
				/** Unloads the plugin instance: hangs up. */
				close: () => Effect.runPromise(Scope.close(held, Exit.void)),
			};
			unwatch.push(fake.watch(opencode, (session) => void connection.request("moved", { session }).catch(() => {})));
			plugins.push(held);
			return connection;
		},
		rpc: <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) => rpc(url, f),
		clients: () => Effect.runPromise(Context.get(services, Clients).count),
		/** How many plugin instances are attached. */
		attached: () => Effect.runPromise(Context.get(services, OpenCode).connected),
		/** Stops the service; the store stays unless `remove`. */
		async close(remove = true) {
			for (const stop of unwatch) stop();
			for (const plugin of plugins) await Effect.runPromise(Scope.close(plugin, Exit.void));
			await Effect.runPromise(Scope.close(scope, Exit.void));
			if (remove) await rm(store, { recursive: true, force: true });
		},
	};
}

const client = RpcClient.make(DeskApi);

/** The desk's API of the service whose page is at `url` (`http://127.0.0.1:<port>/`): its WebSocket, `/rpc`. */
export const wsUrl = (url: string) => link(url, rpcPath).replace(/^http/, "ws");

/**
 * Calls the API of the service at `url` (`http://127.0.0.1:<port>/`) over a WebSocket of its own, as the page does;
 * `headers` go with the upgrade (an `origin`, say, as a browser sends it).
 */
export const rpc = <A, E>(
	url: string,
	f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>,
	headers?: Record<string, string>,
) =>
	Effect.runPromise(
		Effect.scoped(Effect.flatMap(client, f)).pipe(
			Effect.provide(
				RpcClient.layerProtocolSocket().pipe(
					Layer.provide(BunSocket.layerWebSocket(wsUrl(url), headers ? { headers } : undefined)),
					Layer.provide(RpcSerialization.layerNdjson),
				),
			),
		),
	);

/** Polls `check` until it returns something truthy (or throws after `timeout`). */
export async function eventually<A>(check: () => A | Promise<A>, timeout = 3000): Promise<NonNullable<A>> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await check();
		if (value) return value as NonNullable<A>;
		if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
		await Bun.sleep(20);
	}
}
