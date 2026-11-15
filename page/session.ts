/** The desk the page shows, and how desks are named and linked. */
import { createSignal } from "solid-js";
import type { DeskName } from "../src/api/api";
import { deskPath, sessionIn } from "../src/api/routes";

/** The desk the page shows, following the route (the shell sets it); drafts are kept per desk. */
// TODO main | why a global store instead of deriving from route? | by Evgenii Perminov at Sun, 15 Nov 2026 14:36:32 GMT
export const [session, setSession] = createSignal(sessionIn(location.pathname));

/** The current desk's list of entries, or the list of desks. */
export const home = () => {
	const id = session();
	return id === undefined ? "/" : deskPath(id);
};

/** How a desk is shown: its session's title and folder. */
export const deskName = (desk: DeskName | null | undefined) =>
	!desk ? "" : desk.title === desk.folder ? desk.title : `${desk.title} · ${desk.folder}`;
