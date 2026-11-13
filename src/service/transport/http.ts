/**
 * The service's one server, on 127.0.0.1 at the configured port, one for every desk (`/sessions/<id>` picks one): the
 * built page (`page/dist/`), the desk's API for the page and the plugins alike (`/rpc`, a WebSocket: `rpc.ts`), the
 * user's attachments (`/attachments/`), and files relative to an entry's directory for its Markdown media
 * (`/files/<entry id>/<path>`).
 *
 * One guard covers every request: the Host must be a loopback name (a DNS-rebound name gets nothing), and writes and
 * WebSocket upgrades must come from the page itself or from outside a browser (no Origin, or this origin), so other
 * sites open in the browser can't post into a session or call the API.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import { Desk } from "../desk";
import { type Content, Storage } from "../storage/storage";
import * as Rpc from "./rpc";

const Guard = HttpRouter.middleware(
	(app) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const host = request.headers.host ?? "";
			const origin = request.headers.origin;
			if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return HttpServerResponse.text("wrong host", { status: 421 });
			// Browsers send an Origin with every write and every WebSocket upgrade; a plugin, not being one, sends none.
			const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
			if ((request.method !== "GET" || upgrade) && origin !== undefined && origin !== `http://${host}`)
				return HttpServerResponse.text("forbidden", { status: 403 });
			return yield* app;
		}),
	{ global: true },
);

/**
 * A stored file as a response, with its ETag and Last-Modified, as files are served; from disk, Bun sends it as it
 * reads it, ranges included (a video seeks).
 */
const send = (content: Content) =>
	HttpServerResponse.raw(content.data, {
		headers: { etag: etagOf(content), "last-modified": new Date(content.modified).toUTCString() },
	});
/** A strong ETag from the size and the time it last changed, as Effect's file responses make them. */
const etagOf = ({ data, modified }: Content) => `"${data.size.toString(16)}-${modified.toString(16)}"`;

/** Whether an `If-None-Match` header names `etag` (or any, `*`), weak or strong. */
const matches = (ifNoneMatch: string, etag: string) =>
	ifNoneMatch.split(",").some((tag) => {
		const trimmed = tag.trim();
		return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
	});

/** `/files/<entry id>/<path>`: a file below the entry's directory, never outside it. */
const Files = HttpRouter.add("GET", "/files/:id/*", () =>
	Effect.gen(function* () {
		const desk = yield* Desk;
		const storage = yield* Storage;
		const { id, "*": below = "" } = yield* HttpRouter.params;
		const entry = (yield* desk.entries).find((candidate) => candidate.id === id);
		if (!entry) return HttpServerResponse.text("no such entry", { status: 404 });
		return yield* storage.file(entry.directory, below).pipe(
			Effect.map(Option.match({ onNone: () => HttpServerResponse.text("not found", { status: 404 }), onSome: send })),
			Effect.catchTag("Outside", () =>
				Effect.succeed(HttpServerResponse.text("outside the entry's directory", { status: 403 })),
			),
		);
	}),
);

/**
 * `/attachments/<file>`: an attachment the user sent, as its entry links it. As static files are served: ranges
 * advertised, and a 304 for a copy the browser already has.
 */
const Attachments = HttpRouter.add("GET", "/attachments/*", () =>
	Effect.gen(function* () {
		const storage = yield* Storage;
		const request = yield* HttpServerRequest.HttpServerRequest;
		const { "*": file = "" } = yield* HttpRouter.params;
		const content = yield* storage.attachment(`attachments/${file}`);
		if (Option.isNone(content)) return HttpServerResponse.empty({ status: 404 });
		const etag = etagOf(content.value);
		const ifNoneMatch = request.headers["if-none-match"];
		return ifNoneMatch !== undefined && matches(ifNoneMatch, etag)
			? HttpServerResponse.empty({ status: 304, headers: { etag } })
			: HttpServerResponse.setHeader(send(content.value), "accept-ranges", "bytes");
	}),
);

/**
 * Serves the page and the API; needs the `HttpServer` (`server`). `outdated`: whether this service is the outdated side
 * when a plugin's protocol differs (`rpc.ts`).
 */
export const layer = (outdated?: Effect.Effect<boolean, never, FileSystem.FileSystem>) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const page = yield* path.fromFileUrl(new URL("../../../page/dist", import.meta.url));
			return HttpRouter.serve(
				Layer.mergeAll(
					Guard,
					Rpc.layer(outdated),
					Files,
					Attachments,
					// The page as built by Vite (`bun install`, or `bun run page` while editing it); unbuilt, it's a 404.
					// Any other path is one of the page's own routes (`/sessions/<id>/…`): it gets index.html.
					HttpStaticServer.layer({ root: page, spa: true }),
				),
				{ disableLogger: true, disableListenLog: true },
			);
		}),
	);

/**
 * The server on 127.0.0.1:`port` (0, for tests only: any free port); a taken port fails the layer. Its shutdown waits at
 * most a second for open requests: an open page's view stream never ends, so otherwise the service couldn't stop while
 * a page is open (it would wait the server's default 20 seconds).
 */
export const server = (port: number) =>
	Layer.effectContext(
		Layer.build(BunHttpServer.layer({ port, hostname: "127.0.0.1", gracefulShutdownTimeout: "1 second" })).pipe(
			// Bun throws it as it starts to listen.
			Effect.catchDefect((defect) =>
				Predicate.hasProperty(defect, "code") && defect.code === "EADDRINUSE"
					? Effect.fail(new PortTaken({ port }))
					: Effect.die(defect),
			),
		),
	);

/**
 * Another program listens on the port. The service doesn't take another: the page's address and the plugins' way
 * to the service are the port. Reported by whoever runs the service (`main.ts`), so not by the runtime as well.
 */
export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly port: number }> {
	override readonly [Runtime.errorReported] = false;
}
