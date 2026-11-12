/**
 * The page on 127.0.0.1, one port for every desk (`/sessions/<id>` picks one): the built page
 * (`page/dist/`), its RPC API, the user's attachments (`/attachments/`), and files relative to an entry's directory
 * for its Markdown media (`/files/<entry id>/<path>`).
 *
 * One guard covers every request: the Host must be a loopback name (a DNS-rebound name gets nothing), and writes
 * must come from the page itself (no Origin, or this origin), so other sites open in the browser can't post into a
 * session. Each open page is a client of the service (its `view` stream) while it stays open.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Stream from "effect/Stream";
import { Desk } from "../desk";
import { DeskApi } from "../page-api";
import { rpcPath } from "../routes";
import { Api } from "./api";
import { Clients } from "./clients";

const Guard = HttpRouter.middleware(
	(app) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const host = request.headers.host ?? "";
			const origin = request.headers.origin;
			if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return HttpServerResponse.text("wrong host", { status: 421 });
			if (request.method !== "GET" && origin !== undefined && origin !== `http://${host}`)
				return HttpServerResponse.text("forbidden", { status: 403 });
			return yield* app;
		}),
	{ global: true },
);

const Rpcs = RpcServer.layerHttp({ group: DeskApi, path: rpcPath, protocol: "http" }).pipe(
	Layer.provide(
		DeskApi.toLayer(
			Effect.gen(function* () {
				const api = yield* Api;
				const clients = yield* Clients;
				return {
					view: ({ session }) => Stream.unwrap(Effect.as(clients.hold, api.view(session))),
					submit: ({ drafts }) => api.submit(drafts),
					send: (draft) => api.send(draft),
					resolve: ({ id }) => api.resolveByUser(id),
					discard: ({ entry }) => api.discard(entry),
				};
			}),
		),
	),
	Layer.provide(RpcSerialization.layerNdjson),
);

/** `/files/<entry id>/<path>`: a file below the entry's directory, never outside it. */
const Files = HttpRouter.add("GET", "/files/:id/*", () =>
	Effect.gen(function* () {
		const desk = yield* Desk;
		const path = yield* Path.Path;
		const { id, "*": below = "" } = yield* HttpRouter.params;
		const entry = (yield* desk.entries).find((candidate) => candidate.id === id);
		if (!entry) return HttpServerResponse.text("no such entry", { status: 404 });
		const file = path.resolve(entry.directory, below);
		const inside = path.relative(entry.directory, file);
		if (inside.startsWith("..") || path.isAbsolute(inside))
			return HttpServerResponse.text("outside the entry's directory", { status: 403 });
		return yield* HttpServerResponse.file(file).pipe(
			Effect.catch(() => Effect.succeed(HttpServerResponse.text("not found", { status: 404 }))),
		);
	}),
);

/** Serves the page; needs the `HttpServer` (`server`). */
export const layer = (store: string) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const page = yield* path.fromFileUrl(new URL("../../page/dist", import.meta.url));
			return HttpRouter.serve(
				Layer.mergeAll(
					Guard,
					Rpcs,
					Files,
					HttpStaticServer.layer({ root: path.join(store, "attachments"), prefix: "/attachments" }),
					// The page as built by Vite (`bun install`, or `bun run page` while editing it); unbuilt, it's a 404.
					// Any other path is one of the page's own routes (`/sessions/<id>/…`): it gets index.html.
					HttpStaticServer.layer({ root: page, spa: true }),
				),
				{ disableLogger: true, disableListenLog: true },
			);
		}),
	);

/**
 * The page's server on 127.0.0.1:`port` (0: any free port); a taken port fails the layer. Its shutdown waits at most a
 * second for open requests: an open page's view stream never ends, so otherwise the service couldn't stop while a page
 * is open (it would wait the server's default 20 seconds).
 */
export const server = (port: number) =>
	BunHttpServer.layer({ port, hostname: "127.0.0.1", gracefulShutdownTimeout: "1 second" });
