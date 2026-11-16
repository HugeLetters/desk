/**
 * The page's routes: `/` lists the desks, `/sessions/<id>` is one session's desk and `/sessions/<id>/questions/<entry
 * id>` an entry on it. The page's router (`page/main.tsx`) matches these; the service (an entry's or a desk's link for
 * the agent), the TUI badge and the tests link to them, so all of them build the paths here.
 */
import * as Redacted from "effect/Redacted";

/** The router's patterns for the list and for an entry. `/projects/*` is the old list, sent to `/`. */
export const patterns = {
	list: ["/", "/sessions/:session", "/projects/*"],
	entry: "/sessions/:session/questions/:id",
} as const;

/** A session's desk. */
export const deskPath = (session: string) => `/sessions/${encodeURIComponent(session)}`;

/** An entry, on `session`'s desk. */
export const entryPath = (session: string, entry: string) => `${deskPath(session)}/questions/${entry}`;

/** The desk (its session) a path is on (`/sessions/<id>/…`), if any. */
export const sessionIn = (pathname: string) => {
	const id = pathname.match(/^\/sessions\/([^/]+)/)?.[1];
	return id === undefined ? undefined : decodeURIComponent(id);
};

/** The desk's API (`api.ts`), a WebSocket beside the routes, for the page and the plugins alike. */
export const rpcPath = "/rpc";

/**
 * The one host the service listens on and its clients reach it at: loopback only. Not a setting, deliberately: bound
 * anywhere else, the API (which trusts its callers, `api.ts`) would be open to other machines.
 */
export const host = "127.0.0.1";

/** The service's page on `port`: `http://127.0.0.1:<port>/`. */
export const serviceUrl = (port: number) => new URL(`http://${host}:${port}/`);

/** The service's API on `port`: `ws://127.0.0.1:<port>/rpc`. */
export const rpcUrl = (port: number) => new URL(rpcPath, `ws://${host}:${port}/`);

/** A path as a link on the page at `page` (the service's URL, e.g. `http://127.0.0.1:47400/`). */
export const link = (page: URL, path: string) => new URL(path, page);

/** The query parameter a link carries the token in: the service lets the browser in by it, then drops it (`http.ts`). */
export const tokenParam = "token";

/** The cookie the page's token is kept in: one per port, since cookies don't tell ports apart and each is a service. */
export const tokenCookie = (port: number | string) => `desk-${port}`;

/**
 * The `WWW-Authenticate` header of the service's 401: it's the desk's own refusal of a token (a plugin tells a service that
 * doesn't accept its token from another program that refuses its upgrade).
 */
export const challenge = 'Bearer realm="desk"';

/** `url` with the token (`token.ts`): a link a plugin hands out, which lets the browser in. */
export const withToken = (url: URL, token: Redacted.Redacted<string>) => {
	const authorized = new URL(url);
	authorized.searchParams.set(tokenParam, Redacted.value(token));
	return authorized;
};
