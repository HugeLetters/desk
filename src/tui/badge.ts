/**
 * What the TUI's footer badge shows (`index.tsx`), out of the statuses the server part of the plugin gives over
 * OpenCode's plugin RPC (`badge-rpc.ts`). There's one plugin instance per location (directory), each with its own
 * status, so they're kept per location: a session's badge uses its top-level session's location's, the instance
 * connected while that session is in desk mode.
 */
import { deskPath, link } from "../api/routes";
import type { Desk, Status } from "../plugin/badge-rpc";

/** The latest status of each location's plugin instance, by directory. */
export type Statuses = Readonly<Record<string, Status>>;

/** `statuses` with `directory`'s status now `status`. */
export const learn = (statuses: Statuses, directory: string, status: Status): Statuses => ({
	...statuses,
	[directory]: status,
});

/** `statuses` with `directory`'s first status, unless an event has already told it (an answer may come after one). */
export const first = (statuses: Statuses, directory: string, status: Status): Statuses =>
	Object.hasOwn(statuses, directory) ? statuses : learn(statuses, directory, status);

/** The status of the plugin instance in `directory`, if known. */
export const at = (statuses: Statuses, directory: string | undefined): Status | undefined =>
	directory === undefined || !Object.hasOwn(statuses, directory) ? undefined : statuses[directory];

/** The footer's count for a desk: none when nothing waits on the user, else how many do and how many of those are critical. */
export const count = (summary: Desk | undefined) =>
	summary === undefined || summary.waiting === 0 ? undefined : { waiting: summary.waiting, critical: summary.critical };

/** What the badge shows for one desk: where its page is, and its count. */
export interface Report {
	readonly page: string;
	readonly count: ReturnType<typeof count>;
}

/** The badge for `desk` (a top-level session): none unless the plugin is connected and the session is in desk mode. */
export const report = (status: Status | undefined, desk: string | undefined): Report | undefined => {
	const live = status?.live;
	return !live || desk === undefined || !live.deskMode.includes(desk)
		? undefined
		: {
				page: link(live.url, deskPath(desk)),
				count: count(live.desks.find((summary) => summary.session === desk)),
			};
};
