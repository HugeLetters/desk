/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge in sessions with desk mode on, `desk`, or `desk [N]` when N entries of
 * the session's desk wait on the user (`desk [N !M]`, M in red, when M of them are critical). Clicking it opens that
 * desk's page. Hidden in sessions without desk mode, and while no desk service runs. It's the `./tui` part
 * beside the plugin, so it loads wherever the plugin does. Options as the plugin's (`home`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { createSignal, Show } from "solid-js";
import { count, type Status, watch } from "./badge";

/** Opens a URL in the browser; DESK_OPENER replaces `open` for tests. `open` exits at once, once it has handed over. */
const open = (url: string) =>
	// TODO main | use Effect Config module | by Evgenii Perminov at Thu, 12 Nov 2026 18:33:00 GMT
	ChildProcess.make(process.env.DESK_OPENER ?? "open", [url], { stdout: "ignore", stderr: "ignore" }).pipe(
		Effect.flatMap((handle) => handle.exitCode),
		Effect.scoped,
		Effect.ignore,
		Effect.provide(BunServices.layer),
	);

function Badge(props: { context: Context; status: Status | undefined; sessionID: string | undefined }) {
	const context = props.context;
	const [hovered, setHovered] = createSignal(false);
	/** Shown only in a session with desk mode on (a subagent follows its top-level session). */
	/** The top-level session: its desk is this session's. */
	// TODO main | this logic should live higher - badge just gets info about a desk it should report | by Evgenii Perminov at Thu, 12 Nov 2026 18:50:33 GMT
	const root = () =>
		props.sessionID === undefined ? undefined : (context.data.session.root(props.sessionID) ?? props.sessionID);

	const on = () => {
		const session = root();
		return session !== undefined && (props.status?.deskMode.includes(session) ?? false);
	};

	const waiting = () => {
		const summary = props.status?.desks.find((summary) => summary.session === root());
		if (!summary) return;

		return count(summary);
	};
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
				const id = root();
				if (event.button !== 0 || !id || !props.status) return;

				event.preventDefault();
				event.stopPropagation();

				// TODO main | this url consutrction should prob be a helper coming from the webapp router so we're not blindly hoping this works | by Evgenii Perminov at Thu, 12 Nov 2026 18:38:32 GMT
				Effect.runFork(open(`${props.status.url}sessions/${encodeURIComponent(id)}`));
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
		// TODO main | why are we doing string replace | by Evgenii Perminov at Thu, 12 Nov 2026 18:33:14 GMT
		// TODO main | to proper schema validation here | by Evgenii Perminov at Thu, 12 Nov 2026 18:33:14 GMT
		// TODO main | use Config module | by Evgenii Perminov at Thu, 12 Nov 2026 18:33:14 GMT
		// TODO main | effect has api for homerdir and join | by Evgenii Perminov at Thu, 12 Nov 2026 18:51:22 GMT
		const home = String(context.options.home ?? process.env.DESK_HOME ?? join(homedir(), ".local/share/desk")).replace(
			/^~(?=\/|$)/,
			homedir(),
		);
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
