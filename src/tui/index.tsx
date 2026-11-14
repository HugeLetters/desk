/** @jsxImportSource @opentui/solid */
/**
 * The desk in OpenCode's TUI: a footer badge in sessions with desk mode on, `desk`, or `desk [N]` when N entries of
 * the session's desk wait on the user (`desk [N !M]`, M in red, when M of them are critical). Clicking it opens that
 * desk's page. Hidden in sessions without desk mode, and while the plugin isn't connected to the desk service. It's
 * the `./tui` part beside the plugin, so it loads wherever the plugin does. It knows nothing of the service: the
 * plugin's server part, which connects to it (and starts it), tells it what to show over OpenCode's plugin RPC
 * (`badge-rpc.ts`), one status per location. Options as the plugin's (`opener`).
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
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createEffect, createSignal, Show } from "solid-js";
import { BadgeRpc, type Status } from "../plugin/badge-rpc";
import * as Settings from "../shared/settings";
import { at, first, learn, type Report, report, type Statuses } from "./badge";

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

/** The plugin's RPC client, as the TUI's OpenCode client gives it. */
type Client = ReturnType<typeof clientOf>;
const clientOf = (context: Context) => context.client.rpc(BadgeRpc);

/** The `changed` events of every location's plugin instance, for as long as the stream runs. */
const changes = (client: Client) =>
	Stream.callback<{ readonly directory: string; readonly status: Status }>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				client.events.on(
					"changed",
					(event) => void Queue.offerUnsafe(queue, { directory: event.location.directory, status: event.data }),
				),
			),
			(unsubscribe) => Effect.sync(unsubscribe),
		),
	);

/** The status of `directory`'s plugin instance, asking again every couple of seconds while OpenCode's server can't answer. */
const ask = (client: Client, directory: string) =>
	Effect.tryPromise(() => client.status({}, { location: { directory } })).pipe(
		Effect.retry(Schedule.spaced("2 seconds")),
	);

/**
 * The badge in the footer, for as long as it runs: the settings, the slot, and the statuses of the plugin's instances
 * into it. A location's is asked for once a session there shows the badge, and kept up to date by its events.
 */
const badge = (context: Context) =>
	Effect.gen(function* () {
		const opener = yield* Settings.opener;
		const client = clientOf(context);
		const run = yield* FiberSet.makeRuntime<ChildProcessSpawner.ChildProcessSpawner>();
		const [statuses, setStatuses] = createSignal<Statuses>({});
		/** The locations asked for so far. */
		const asked = yield* Ref.make<ReadonlySet<string>>(new Set());
		/** Asks `directory`'s instance, the first time only; its events tell the rest. */
		const watch = (directory: string) =>
			Effect.gen(function* () {
				const known = yield* Ref.getAndUpdate(asked, (seen) => new Set([...seen, directory]));
				if (known.has(directory)) return;
				const status = yield* ask(client, directory);
				yield* Effect.sync(() => setStatuses((now) => first(now, directory, status)));
			});
		/** Asks every location asked before again: after OpenCode's server reconnects, its events since are lost. */
		const again = Effect.flatMap(Ref.get(asked), (seen) =>
			Effect.forEach(
				seen,
				(directory) =>
					Effect.flatMap(ask(client, directory), (status) =>
						Effect.sync(() => setStatuses((now) => learn(now, directory, status))),
					),
				{ concurrency: "unbounded", discard: true },
			),
		);
		/** The desk a session's badge reports: its top-level session's (a subagent's desk is its parent's). */
		const deskOf = (sessionID: string | undefined) =>
			sessionID === undefined ? undefined : (context.data.session.root(sessionID) ?? sessionID);
		/** Where that desk's plugin instance is: its session's location (else the session's own, until it's loaded). */
		const locationOf = (sessionID: string | undefined, desk: string | undefined) =>
			(desk === undefined ? undefined : context.data.session.get(desk)?.location.directory) ??
			(sessionID === undefined ? undefined : context.data.session.get(sessionID)?.location.directory);
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				context.ui.slot({
					append: "prompt.footer.status",
					render: (slot) => {
						const desk = () => deskOf(slot.sessionID);
						const location = () => locationOf(slot.sessionID, desk());
						createEffect(() => {
							const directory = location();
							if (directory !== undefined) run(watch(directory));
						});
						return (
							<Badge
								theme={context.theme}
								report={report(at(statuses(), location()), desk())}
								open={(page) => run(open(opener, page))}
							/>
						);
					},
				}),
			),
			(unslot) => Effect.sync(unslot),
		);
		yield* Effect.acquireRelease(
			Effect.sync(() => context.data.on("server.connected", () => void run(again))),
			(unsubscribe) => Effect.sync(unsubscribe),
		);
		yield* Stream.runForEach(changes(client), ({ directory, status }) =>
			Effect.sync(() => setStatuses((now) => learn(now, directory, status))),
		);
	}).pipe(Effect.scoped);

/** What the badge needs, on Bun: provided here, at the TUI's entry, and nowhere below. */
const services = BunServices.layer;

export default Plugin.define({
	id: "desk",
	setup(context) {
		const running = Effect.runFork(badge(context).pipe(Effect.provide([services, Settings.layer(context.options)])));
		return () => Effect.runPromise(Effect.asVoid(Fiber.interrupt(running)));
	},
});
