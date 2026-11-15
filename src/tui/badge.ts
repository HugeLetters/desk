/**
 * What the TUI's footer badge shows (`index.tsx`), as the server part of the plugin gives it over OpenCode's plugin RPC
 * (`badge-rpc.ts`): a session's badge, asked of the plugin instance in the session's directory, which is the one
 * connected while that session is in desk mode.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { SessionID } from "../model/entry";
import type { BadgeRpc, Status } from "../plugin/badge-rpc";
import type { RpcClient } from "./rpc-client";

/** The footer's count: none when nothing waits on the user, else how many do and how many of those are critical. */
export const count = (status: Status) =>
	status.waiting === 0 ? undefined : { waiting: status.waiting, critical: status.critical };

/** `session`'s badge, asked of `directory`'s plugin instance, again every couple of seconds while the call fails. */
export const ask = (client: RpcClient<typeof BadgeRpc>, session: SessionID, directory: string) =>
	client.status({ session }, { location: { directory } }).pipe(Effect.retry(Schedule.spaced("2 seconds")));

/**
 * `session`'s badge now, then again on each `changed` from `directory`'s instance and each of `reconnects` (after
 * OpenCode's server reconnects, the events since are lost). A newer ask replaces one still waiting.
 */
export const follow = (
	client: RpcClient<typeof BadgeRpc>,
	session: SessionID,
	directory: string,
	reconnects: Stream.Stream<void>,
) => {
	// One that doesn't decode ends the subscription, so it's taken out again.
	const changed = client.events("changed").pipe(
		Stream.retry(Schedule.forever),
		Stream.filter((event) => event.location.directory === directory),
	);

	return Stream.make(undefined).pipe(
		Stream.merge(Stream.merge(changed, reconnects)),
		Stream.switchMap(() => Stream.fromEffect(ask(client, session, directory))),
	);
};
