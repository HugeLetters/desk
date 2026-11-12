/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge in sessions with desk mode on, `desk`, or `desk [N]` when N entries of
 * the session's desk wait on the user (`desk [N !M]`, M in red, when M of them are critical). Clicking it opens that
 * desk's page. Hidden in sessions without desk mode, and while no desk service runs. It's the `./tui` part
 * beside the plugin, so it loads wherever the plugin does. Options as the plugin's (`home`).
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Stream from "effect/Stream";
import { createSignal, Show } from "solid-js";
import { type Report, report, type Status, watch } from "./badge";
import * as Settings from "./settings";

/** Opens `url` in the browser with `opener` (`open`, which exits at once, once it has handed over). */
const open = (opener: string, url: string) =>
	ChildProcess.make(opener, [url], { stdout: "ignore", stderr: "ignore" }).pipe(
		Effect.flatMap((handle) => handle.exitCode),
		Effect.scoped,
		Effect.ignore,
	);

/** The badge for one desk; `report` is undefined to hide it. */
function Badge(props: { theme: Context["theme"]; report: Report | undefined; open: (page: string) => void }) {
	const [hovered, setHovered] = createSignal(false);
	// Like the footer's location: muted, base under the mouse (it's clickable); the count always bright, critical ones in the error color.
	return (
		<text
			visible={props.report !== undefined}
			marginLeft={1}
			selectable={false}
			fg={hovered() ? props.theme.text.base : props.theme.text.muted}
			onMouseOver={() => setHovered(true)}
			onMouseOut={() => setHovered(false)}
			onMouseDown={(event) => {
				const shown = props.report;
				if (event.button !== 0 || !shown) return;

				event.preventDefault();
				event.stopPropagation();
				props.open(shown.page);
			}}
		>
			desk
			<Show when={props.report?.count}>
				{(count) => (
					<>
						{" ["}
						<span style={{ fg: props.theme.text.base }}>{count().waiting}</span>
						<Show when={count().critical > 0}>
							<span style={{ fg: props.theme.text.feedback.error.base }}> !{count().critical}</span>
						</Show>
						]
					</>
				)}
			</Show>
		</text>
	);
}

/**
 * The badge in the footer, for as long as it runs: the settings, the slot, and the registered service's status into
 * it. `DESK_OPENER` replaces `open`, for tests.
 */
const badge = (context: Context) =>
	Effect.gen(function* () {
		const home = yield* Settings.home(context.options);
		const opener = yield* Config.String("DESK_OPENER").pipe(Config.withDefault("open"));
		const run = yield* FiberSet.makeRuntime<ChildProcessSpawner.ChildProcessSpawner>();
		const [status, setStatus] = createSignal<Status>();
		/** The desk a session's badge reports: its top-level session's (a subagent's desk is its parent's). */
		const deskOf = (sessionID: string | undefined) =>
			sessionID === undefined ? undefined : (context.data.session.root(sessionID) ?? sessionID);
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				context.ui.slot({
					append: "prompt.footer.status",
					render: (slot) => (
						<Badge
							theme={context.theme}
							report={report(status(), deskOf(slot.sessionID))}
							open={(page) => run(open(opener, page))}
						/>
					),
				}),
			),
			(unslot) => Effect.sync(unslot),
		);
		yield* Stream.runForEach(watch(home), (next) => Effect.sync(() => setStatus(next)));
	}).pipe(Effect.scoped);

/** What the badge needs, on Bun: provided here, at the TUI's entry, and nowhere below. */
const services = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, RpcSerialization.layerNdjson);

export default Plugin.define({
	id: "desk",
	setup(context) {
		const running = Effect.runFork(badge(context).pipe(Effect.provide(services)));
		return () => Effect.runPromise(Effect.asVoid(Fiber.interrupt(running)));
	},
});
