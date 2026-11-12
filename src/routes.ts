/**
 * The page's routes: `/` lists the desks, `/sessions/<id>` is one session's desk and `/sessions/<id>/questions/<entry
 * id>` an entry on it. The page's router (`page/main.tsx`) matches these; the service (an entry's or a desk's link for
 * the agent), the TUI badge and the tests link to them, so all of them build the paths here.
 */

/** The router's patterns for the list and for an entry. `/projects/*` is the old list, sent to `/`. */
export const patterns = {
	list: ["/", "/sessions/:session", "/projects/*"],
	entry: "/sessions/:session/questions/:id",
} as const;

/** A session's desk. */
export const deskPath = (session: string) => `/sessions/${encodeURIComponent(session)}`;

/** An entry, on `session`'s desk (or, without one, below the current path). */
export const entryPath = (session: string | undefined, entry: string) =>
	`${session === undefined ? "" : deskPath(session)}/questions/${entry}`;

/** The desk (its session) a path is on (`/sessions/<id>/…`), if any. */
export const sessionIn = (pathname: string) => {
	const id = pathname.match(/^\/sessions\/([^/]+)/)?.[1];
	return id === undefined ? undefined : decodeURIComponent(id);
};

/** A path as a link on the page at `page` (the service's URL, e.g. `http://127.0.0.1:47400/`). */
export const link = (page: string, path: string) => `${page.replace(/\/$/, "")}${path}`;
