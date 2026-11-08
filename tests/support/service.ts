/**
 * A desk service in this process, on a temporary store, a free port and fake OpenCode servers. Plugin instances
 * reach it the way the plugin does (`plugin/connection.ts`, over the socket); pages through the typed RPC client.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Scope from "effect/Scope";
import { DeskApi } from "../../src/page-api";
import { connect, type Connection } from "../../src/plugin/connection";
import type { Endpoint } from "../../src/protocol";
import { Api } from "../../src/service/api";
import * as App from "../../src/service/app";
import { Clients } from "../../src/service/clients";
import { fakeOpenCode } from "./fake-opencode";

export type Service = Awaited<ReturnType<typeof startService>>;

export async function startService(options: { store?: string; idle?: number; fake?: ReturnType<typeof fakeOpenCode> } = {}) {
	const store = options.store ?? (await mkdtemp(join(tmpdir(), "desk-")));
	const fake = options.fake ?? fakeOpenCode();
	const socket = join(store, "desk.sock");
	const scope = Effect.runSync(Scope.make());
	const services = (await Effect.runPromise(
		Layer.buildWithScope(App.layer({ store, socket, port: 0, idle: options.idle ?? 60_000, retry: "50 millis", connect: fake.connect }), scope),
	)) as Context.Context<Api | Clients>;
	const url = Context.get(services, Api).url;
	const plugins: Array<Connection> = [];

	const client = RpcClient.make(DeskApi);
	return {
		store,
		socket,
		url,
		fake,
		services,
		/** A plugin instance of the OpenCode at `opencode`, in `project`. */
		plugin(opencode?: Endpoint, project = { id: "prj_default", directory: "/work/default" }) {
			const connection = connect({ socket, start: () => {}, hello: () => ({ opencode, project }), timeout: 1000 });
			plugins.push(connection);
			return connection;
		},
		rpc: <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
			Effect.runPromise(
				Effect.scoped(Effect.flatMap(client, f)).pipe(
					Effect.provide(RpcClient.layerProtocolHttp({ url: `${url}rpc` }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))),
				),
			),
		clients: () => Effect.runPromise(Context.get(services, Clients).count),
		/** Stops the service; the store stays unless `remove`. */
		async close(remove = true) {
			for (const plugin of plugins) plugin.close();
			await Effect.runPromise(Scope.close(scope, Exit.void));
			if (remove) await rm(store, { recursive: true, force: true });
		},
	};
}

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
