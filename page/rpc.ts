/** The desk's API over one WebSocket to this page's server, for as long as the page is open; it reconnects by itself. */
import * as BrowserSocket from "@effect/platform-browser/BrowserSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { DeskApi } from "../src/api/api";
import { rpcPath } from "../src/api/routes";

export const runtime = ManagedRuntime.make(
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(
			Socket.layerWebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${rpcPath}`),
		),
		Layer.provide([BrowserSocket.layerWebSocketConstructor, RpcSerialization.layerNdjson]),
	),
);

const client = RpcClient.make(DeskApi);

export const withClient = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
	Effect.scoped(Effect.flatMap(client, f));

/** Calls the desk; rejects with the desk's message. */
export const call = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
	runtime.runPromise(withClient(f));

/**
 * Whether the service still lets this browser in (its cookie, `http.ts`): a refused WebSocket doesn't say why, so this
 * asks for the page itself. Unreachable counts as let in: that's the service being away, not refusing.
 */
export const letIn = Effect.promise(() =>
	fetch("/", { method: "HEAD", cache: "no-store" }).then(
		(response) => response.status !== 401,
		() => true,
	),
);
