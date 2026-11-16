/**
 * The service's one server, on 127.0.0.1 at the configured port, one for every desk (`/sessions/<id>` picks one): the
 * built page (`page/dist/`), the desk's API for the page and the plugins alike (`/rpc`, a WebSocket: `rpc.ts`), the
 * user's attachments (`/attachments/`), and files relative to an entry's directory for its Markdown media
 * (`/files/<entry id>/<path>`).
 *
 * One guard covers every request: the Host must be a loopback name (a DNS-rebound name gets nothing), writes and
 * WebSocket upgrades must come from the page itself or from outside a browser (no Origin, or this origin), so other
 * sites open in the browser can't post into a session or call the API, and every request needs the store's token
 * (`token.ts`): a cookie (the page's browser) or a bearer header (a plugin). A link with `?token=` sets the cookie
 * and sends the browser on without it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
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
import * as Redacted from "effect/Redacted";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { challenge, host, tokenCookie, tokenParam } from "../../api/routes";
import { type Port, RelativePath } from "../../model/paths";
import { Token } from "../../shared/token";
import { Desk } from "../desk";
import { type Content, Storage } from "../storage/storage";
import * as Rpc from "./rpc";

/** A Host header that names the service on a loopback name: {@link host} or `localhost`, and a port. */
const loopbackHost = new RegExp(`^(${host.replaceAll(".", "\\.")}|localhost):\\d+$`);

const Guard = HttpRouter.middleware(
	(app) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const hostHeader = request.headers.host ?? "";
			const origin = request.headers.origin;
			if (!loopbackHost.test(hostHeader)) {
				return HttpServerResponse.text("wrong host", { status: 421 });
			}

			// Browsers send an Origin with every write and every WebSocket upgrade; a plugin, not being one, sends none.
			const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
			if ((request.method !== "GET" || upgrade) && origin !== undefined && origin !== `http://${hostHeader}`) {
				return HttpServerResponse.text("forbidden", { status: 403 });
			}

			const token = yield* Token;
			const cookie = tokenCookie(hostHeader.slice(hostHeader.lastIndexOf(":") + 1));
			const url = HttpServerRequest.toURL(request);
			const given = Option.flatMapNullishOr(url, (requested) => requested.searchParams.get(tokenParam));
			// A link that carries the token: the browser keeps it as a cookie, and goes on without it in the address bar.
			if (request.method === "GET" && !upgrade && Option.isSome(url) && Option.isSome(given)) {
				if (!isToken(token, given.value)) return unauthorized();

				const without = new URL(url.value);
				without.searchParams.delete(tokenParam);
				return HttpServerResponse.redirect(`${without.pathname}${without.search}`, { status: 302 }).pipe(
					HttpServerResponse.setCookieUnsafe(cookie, Redacted.value(token), {
						httpOnly: true,
						sameSite: "strict",
						path: "/",
						maxAge: "400 days",
					}),
				);
			}

			const presented = [request.cookies[cookie], bearer(request.headers.authorization)];
			if (!presented.some((candidate) => candidate !== undefined && isToken(token, candidate))) return unauthorized();

			return yield* app;
		}),
	{ global: true },
);

/** SHA-256 of `value`: what's compared, so that both sides have the same length. */
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether `given` is the token, compared in constant time. */
const isToken = (token: Redacted.Redacted<string>, given: string) =>
	timingSafeEqual(digest(Redacted.value(token)), digest(given));

/** The token in an `Authorization: Bearer <token>` header. */
const bearer = (authorization: string | undefined) => authorization?.match(/^Bearer (.+)$/i)?.[1];

/** No token, or not the store's: the text says how to get in, and the header that it's the desk's (`routes.ts`'s `challenge`). */
const unauthorized = () =>
	HttpServerResponse.text(
		"Not let in: open the desk from OpenCode once (/desk-mode's link, or the footer's desk badge). Its link lets this browser in.",
		{ status: 401, headers: { "www-authenticate": challenge } },
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

const decodeRelative = Schema.decodeUnknownOption(RelativePath);

/** `/files/<entry id>/<path>`: a file below the entry's directory, never outside it. */
const Files = HttpRouter.add(
	"GET",
	"/files/:id/*",
	Effect.gen(function* () {
		const desk = yield* Desk;
		const storage = yield* Storage;
		const { id, "*": path = "" } = yield* HttpRouter.params;
		const entry = (yield* desk.entries).find((candidate) => candidate.id === id);
		if (!entry) return HttpServerResponse.text("no such entry", { status: 404 });
		if (entry.directory === null) return HttpServerResponse.text("this entry has no folder", { status: 404 });

		// Not a path below the directory (absolute, or climbing out of it): never read.
		const below = decodeRelative(path);
		if (Option.isNone(below)) return HttpServerResponse.text("outside the entry's directory", { status: 403 });

		return Option.match(yield* storage.file(entry.directory, below.value), {
			onNone: () => HttpServerResponse.text("not found", { status: 404 }),
			onSome: send,
		});
	}),
);

/**
 * `/attachments/<file>`: an attachment the user sent, as its entry links it. As static files are served: ranges
 * advertised, and a 304 for a copy the browser already has.
 */
const Attachments = HttpRouter.add(
	"GET",
	"/attachments/*",
	Effect.gen(function* () {
		const storage = yield* Storage;
		const request = yield* HttpServerRequest.HttpServerRequest;
		const { "*": file = "" } = yield* HttpRouter.params;
		const below = decodeRelative(`attachments/${file}`);
		const content = Option.isSome(below) ? yield* storage.attachment(below.value) : Option.none();
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
			const page = path.resolve(import.meta.dir, "../../../page/dist");
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
export const server = (port: Port | 0) =>
	Layer.effectContext(
		Layer.build(BunHttpServer.layer({ port, hostname: host, gracefulShutdownTimeout: "1 second" })).pipe(
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
export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly port: Port | 0 }> {
	override readonly [Runtime.errorReported] = false;
}
