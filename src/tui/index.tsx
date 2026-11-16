/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge in sessions with desk mode on, `desk`, or `desk [N]` when N entries of
 * the session's desk wait on the user (`desk [N !M]`, M in red, when M of them are critical). Clicking it opens that
 * desk's page. Hidden in sessions without desk mode, and while the plugin isn't connected to the desk service. It's
 * the `./tui` part beside the plugin, so it loads wherever the plugin does. It knows nothing of the service: the
 * plugin's server part, which connects to it (and starts it), tells it what to show over OpenCode's plugin RPC
 * (`badge-rpc.ts`): each session's badge, asked of the instance in its directory. Options as the plugin's (`opener`).
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { SessionID } from "../model/entry";
import { invalidSetting } from "../model/wording";
import { BadgeRpc, type Status } from "../plugin/badge-rpc";
import * as Settings from "../shared/settings";
import { count, follow } from "./badge";
import { rpcClient } from "./rpc-client";

/** Opens `url` in the browser with `opener` (`open`, which exits at once, once it has handed over). */
const open = (opener: string, url: URL) =>
	ChildProcess.make(opener, [url.href], { stdout: "ignore", stderr: "ignore" }).pipe(
		Effect.flatMap((handle) => handle.exitCode),
		Effect.scoped,
		Effect.ignore,
	);

/** The badge for one session; `status` is null to hide it. */
function Badge(props: { theme: Context["theme"]; status: Status | null; open: (page: URL) => void }) {
	const [hovered, setHovered] = createSignal(false);

	// Like the footer's location: muted, base under the mouse (it's clickable); the count always bright, critical ones in the error color.
	return (
		<text
			visible={props.status !== null}
			marginLeft={1}
			selectable={false}
			fg={hovered() ? props.theme.text.base : props.theme.text.muted}
			onMouseOver={() => setHovered(true)}
			onMouseOut={() => setHovered(false)}
			onMouseDown={(event) => {
				const shown = props.status;
				if (event.button !== 0 || !shown) return;

				event.preventDefault();
				event.stopPropagation();
				props.open(shown.page);
			}}
		>
			desk
			<Show when={props.status && count(props.status)}>
				{(counted) => (
					<>
						{" ["}
						<span style={{ fg: props.theme.text.base }}>{counted().waiting}</span>
						<Show when={counted().critical > 0}>
							<span style={{ fg: props.theme.text.feedback.error.base }}> !{counted().critical}</span>
						</Show>
						]
					</>
				)}
			</Show>
		</text>
	);
}

/**
 * The badge in the footer, for as long as it runs: the settings, and the slot, each session's badge in it asked of the
 * plugin instance in that session's directory, and asked again when that instance says something changed.
 */
const badge = Effect.fn("badge")(function* (context: Context) {
	// A setting that isn't valid: no badge (the plugin's server part says what to fix), and the reason, once, in the log.
	const settings = yield* Settings.all.pipe(Effect.catchTag("InvalidSetting", Effect.succeed));
	if (settings instanceof Settings.InvalidSetting) {
		return yield* Effect.logError(`desk: no badge. ${invalidSetting(settings.name, settings.message)}`);
	}

	const { opener } = settings;
	const client = rpcClient(BadgeRpc, context);
	const run = yield* FiberSet.makeRuntime<ChildProcessSpawner.ChildProcessSpawner>();

	/** Each time OpenCode's server reconnects, while the stream runs. */
	const reconnects = Stream.callback<void>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => context.data.on("server.connected", () => void Queue.offerUnsafe(queue, undefined))),
			(unsubscribe) => Effect.sync(unsubscribe),
		),
	);

	yield* Effect.acquireRelease(
		Effect.sync(() =>
			context.ui.slot({
				append: "prompt.footer.status",
				render: (slot) => {
					const [status, setStatus] = createSignal<Status | null>(null);
					/** Where the session works: its plugin instance is the one connected while its desk is in desk mode. */
					const directory = () =>
						slot.sessionID === undefined ? undefined : context.data.session.get(slot.sessionID)?.location.directory;
					createEffect(() => {
						const session = slot.sessionID;
						const at = directory();
						setStatus(null);
						if (session === undefined || at === undefined) return;

						const following = run(
							follow(client, SessionID.make(session), at, reconnects).pipe(
								Stream.runForEach((now) => Effect.sync(() => setStatus(now))),
							),
						);
						onCleanup(() => run(Fiber.interrupt(following)));
					});
					return <Badge theme={context.theme} status={status()} open={(page) => run(open(opener, page))} />;
				},
			}),
		),
		(unslot) => Effect.sync(unslot),
	);

	return yield* Effect.never;
}, Effect.scoped);

export default Plugin.define({
	id: "desk",
	setup(context) {
		const running = badge(context).pipe(
			Effect.provide([BunServices.layer, Settings.layer(context.options)]),
			Effect.runFork,
		);
		return () => Fiber.interrupt(running).pipe(Effect.runPromise);
	},
});
