/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge in sessions with desk mode on, `desk`, or `desk [N]` when N entries of
 * the session's project wait on the user (`desk [N !M]`, M in red, when M of them are critical). Clicking it opens that
 * project's desk page. Hidden in sessions without desk mode, and while no desk service runs. It's the `./tui` part
 * beside the plugin, so it loads wherever the plugin does. Options as the plugin's (`home`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { createSignal, Show } from "solid-js";
import { count, type Status, watch } from "./badge";

/** Opens a URL in the browser; DESK_OPENER replaces `open` for tests. */
const open = (url: string) =>
	Bun.spawn([process.env.DESK_OPENER ?? "open", url], { stdout: "ignore", stderr: "ignore" });

function Badge(props: { context: Context; status: Status | undefined; sessionID: string | undefined }) {
	const context = props.context;
	const [hovered, setHovered] = createSignal(false);
	/** Shown only in a session with desk mode on (a subagent follows its top-level session). */
	const on = () =>
		props.sessionID !== undefined &&
		(props.status?.deskMode.includes(context.data.session.root(props.sessionID) ?? props.sessionID) ?? false);
	const projectID = () =>
		props.sessionID === undefined ? undefined : context.data.session.get(props.sessionID)?.projectID;
	const waiting = () => count(props.status?.projects.find((summary) => summary.id === projectID()));
	// Like the footer's location: muted, base under the mouse (it's clickable); the count always bright, critical ones in the error color.
	return (
		<text
			visible={on()}
			marginLeft={1}
			selectable={false}
			fg={hovered() ? context.theme.text.base : context.theme.text.muted}
			onMouseOver={() => setHovered(true)}
			onMouseOut={() => setHovered(false)}
			onMouseDown={(event) => {
				const id = projectID();
				if (event.button !== 0 || !id || !props.status) return;
				event.preventDefault();
				event.stopPropagation();
				open(`${props.status.url}projects/${encodeURIComponent(id)}`);
			}}
		>
			desk
			<Show when={waiting()}>
				{(shown) => (
					<>
						{" ["}
						<span style={{ fg: context.theme.text.base }}>{shown().waiting}</span>
						<Show when={shown().critical > 0}>
							<span style={{ fg: context.theme.text.feedback.error.base }}> !{shown().critical}</span>
						</Show>
						]
					</>
				)}
			</Show>
		</text>
	);
}

export default Plugin.define({
	id: "desk",
	setup(context) {
		const home = String(
			context.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk"),
		).replace(/^~(?=\/|$)/, homedir());
		const [status, setStatus] = createSignal<Status>();
		const watching = Effect.runFork(
			Stream.runForEach(watch(home), (next) => Effect.sync(() => setStatus(next))),
		);
		const unslot = context.ui.slot({
			append: "prompt.footer.status",
			render: (slot) => (
				<Badge
					context={context}
					status={status()}
					sessionID={slot.sessionID}
				/>
			),
		});
		return () => {
			unslot();
			Effect.runFork(Fiber.interrupt(watching));
		};
	},
});
