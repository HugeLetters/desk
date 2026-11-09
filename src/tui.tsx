/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge, `desk N` when N entries of the session's project wait on the user (`!M`
 * in red when M of them are critical). Clicking it opens that project's desk page. Hidden in projects with nothing on
 * the desk, and while no desk service runs. It's the `./tui` part beside the plugin, so it loads wherever the plugin
 * does. Options as the plugin's (`home`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { createSignal, Show } from "solid-js";
import { label, type Status, watch } from "./badge";

/** Opens a URL in the browser; DESK_OPENER replaces `open` for tests. */
const open = (url: string) => Bun.spawn([process.env.DESK_OPENER ?? "open", url], { stdout: "ignore", stderr: "ignore" });

function Badge(props: { context: Context; status: Status | undefined; sessionID: string | undefined }) {
	const context = props.context;
	const [hovered, setHovered] = createSignal(false);
	const project = () => {
		const session = props.sessionID === undefined ? undefined : context.data.session.get(props.sessionID);
		const id = session?.projectID ?? context.data.project.list().find((project) => project.canonical === (context.location ?? context.data.location.default()).directory)?.id;
		return props.status?.projects.find((summary) => summary.id === id);
	};
	// Like the footer's other items: base text, muted under the mouse (it's clickable); critical counts in the error color.
	const critical = () => project()?.critical ?? 0;
	return (
		<text
			visible={project() !== undefined}
			marginLeft={1}
			selectable={false}
			fg={hovered() ? context.theme.text.muted : context.theme.text.base}
			onMouseOver={() => setHovered(true)}
			onMouseOut={() => setHovered(false)}
			onMouseDown={(event) => {
				const summary = project();
				if (event.button !== 0 || !summary || !props.status) return;
				event.preventDefault();
				event.stopPropagation();
				open(`${props.status.url}projects/${encodeURIComponent(summary.id)}`);
			}}
		>
			{label(project() && { ...project()!, critical: 0 })}
			<Show when={critical() > 0}>
				<span style={{ fg: context.theme.text.feedback.error.base }}> !{critical()}</span>
			</Show>
		</text>
	);
}

export default Plugin.define({
	id: "desk",
	setup(context) {
		const home = String(context.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk")).replace(/^~(?=\/|$)/, homedir());
		const [status, setStatus] = createSignal<Status>();
		const watching = Effect.runFork(Stream.runForEach(watch(home), (next) => Effect.sync(() => setStatus(next))));
		const unslot = context.ui.slot({
			append: "prompt.footer.status",
			render: (slot) => <Badge context={context} status={status()} sessionID={slot.sessionID} />,
		});
		return () => {
			unslot();
			Effect.runFork(Fiber.interrupt(watching));
		};
	},
});
