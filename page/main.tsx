/** @jsxImportSource solid-js */
/**
 * The desk page: one session's desk (`/sessions/<id>`; at `/`, the list of desks), its open entries as a flat list,
 * and an entry view (`/sessions/<id>/questions/<entry id>`) with its parent, follow-ups, a draft box and Next.
 * Moving to another desk, like every link here, stays on the page: the view and the drafts follow the route.
 * Drafts live in the browser until Submit (all of them, one message per session), ⌘↵ (the same, then Next) or Send now (one, steering).
 */

import { MetaProvider, Title } from "@solidjs/meta";
import { A, Route, Router, useLocation, useNavigate, useParams } from "@solidjs/router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { createEffect, createMemo, createSignal, For, on, onCleanup, type ParentProps, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { DeskApi, type Draft, type View } from "../src/api/api";
import { deskPath, entryPath, patterns, rpcPath, sessionIn } from "../src/api/routes";
import {
	type Entry,
	type EntryId,
	newId,
	next,
	openBelow,
	openUnder,
	ordered,
	shortId,
	waitingFor,
	waitingOn,
} from "../src/model/entry";
import { Refusal } from "../src/model/errors";
import { deliveryFailed, refusal } from "../src/model/wording";
import * as Attachments from "./attachments";
import { type Local, render as markdown, renderDiagrams } from "./markdown";

const isRefusal = Schema.is(Refusal);

/** The desk's API over one WebSocket to this page's server, for as long as the page is open; it reconnects by itself. */
const runtime = ManagedRuntime.make(
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(
			Socket.layerWebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${rpcPath}`),
		),
		Layer.provide([Socket.layerWebSocketConstructorGlobal, RpcSerialization.layerNdjson]),
	),
);
const client = RpcClient.make(DeskApi);
const withClient = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
	Effect.scoped(Effect.flatMap(client, f));
/** Calls the desk; rejects with the desk's message. */
const call = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
	runtime.runPromise(withClient(f));

/** Small inline icons (Lucide-style strokes), so buttons need no icon font. */
const icons = {
	attach: "m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
	send: "m22 2-7 20-4-9-9-4Zm0 0L11 13",
	now: "M13 2 3 14h9l-1 8 10-12h-9Z",
	next: "M5 12h14m-7-7 7 7-7 7",
	done: "M20 6 9 17l-5-5",
	copy: "M8 8h12v12H8ZM4 16V4h12",
};
const Icon = (props: { name: keyof typeof icons }) => (
	<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
		<path d={icons[props.name]} />
	</svg>
);

/** The desk the page shows, following the route; drafts are kept per desk. */
const [session, setSession] = createSignal(sessionIn(location.pathname));
const draftsPrefix = "desk.drafts.";
const draftsKey = (id: string | undefined) => `${draftsPrefix}${id ?? ""}`;
const loadDrafts = (key: string): Partial<Record<string, string>> => JSON.parse(localStorage.getItem(key) ?? "{}");
/** How a desk is shown: its session's title and folder. */
const deskName = (desk: { readonly title: string; readonly folder: string } | null | undefined) =>
	!desk ? "" : desk.title === desk.folder ? desk.title : `${desk.title} · ${desk.folder}`;
const home = () => {
	const id = session();
	return id === undefined ? "/" : deskPath(id);
};
/** An entry on the current desk. */
const entryOnDesk = (id: string) => entryPath(session(), id);

function Markdown(props: { text: string; entry: string; local?: Local }) {
	let container: HTMLDivElement | undefined;
	createEffect(() => {
		// Solid sets the ref before effects run.
		if (!container) return;
		container.innerHTML = markdown(props.text, `/files/${props.entry}/`, props.local);
		void renderDiagrams(container);
	});
	return <div class="md" ref={container} />;
}

function App() {
	const [state, setState] = createStore<{ view: View | null; online: boolean }>({ view: null, online: true });
	/** The current desk's drafts, saved under its key; another desk swaps them for its own. */
	let currentDrafts = draftsKey(session());
	const [drafts, setDrafts] = createStore<Partial<Record<string, string>>>(loadDrafts(currentDrafts));
	const [toast, setToast] = createSignal<{ message: string; error: boolean }>();
	createEffect(() => localStorage.setItem(currentDrafts, JSON.stringify(drafts)));
	createEffect(
		on(
			session,
			(id) => {
				currentDrafts = draftsKey(id);
				setDrafts(reconcile(loadDrafts(currentDrafts)));
			},
			{ defer: true },
		),
	);
	/** The drafts' attachments, with object URLs for their previews; the files themselves wait in IndexedDB until sent. */
	const [files, setFiles] = createStore<Partial<Record<string, Attachments.Local & { url: string }>>>({});
	const keep = (file: Attachments.Local) => setFiles(file.id, { ...file, url: URL.createObjectURL(file.blob) });
	/**
	 * Lets go of the attachments no draft references anymore: those just sent, those whose draft went, and links deleted
	 * from the text. Other desks' drafts count too: their files share the browser's store.
	 */
	const prune = () => {
		const others = Object.keys(localStorage).filter((key) => key.startsWith(draftsPrefix) && key !== currentDrafts);
		const texts = [...Object.values(drafts), ...others.flatMap((key) => Object.values(loadDrafts(key)))];
		const used = new Set(texts.flatMap((text) => [...Attachments.referenced(text ?? "")]));
		const unused = Object.keys(files).filter((id) => !used.has(id));
		for (const id of unused) {
			const file = files[id];
			if (file) URL.revokeObjectURL(file.url);
			setFiles(id, undefined);
		}
		return Attachments.remove(unused);
	};
	const loaded = Attachments.all()
		.then((stored) => {
			for (const file of stored) keep(file);
			return prune();
		})
		.catch(() => {});

	// One view at a time, of the desk the route shows.
	createEffect(
		on(session, (id) => {
			const subscription = runtime.runFork(
				withClient((desk) =>
					desk.view({ session: id }).pipe(
						Stream.runForEach((view) =>
							Effect.sync(() => {
								// The previous desk's stream may still deliver one before it stops.
								if ((view.desk?.session ?? undefined) !== id) return;
								setState("online", true);
								setState("view", reconcile(view, { key: "id", merge: true }));
								// A draft for an entry that left the desk can't be sent anymore.
								const gone = Object.keys(drafts).filter((entry) => !view.entries.some((other) => other.id === entry));
								for (const entry of gone) setDrafts(entry, undefined);
								if (gone.length > 0) void loaded.then(prune);
							}),
						),
					),
				).pipe(
					Effect.tapError(() => Effect.sync(() => setState("online", false))),
					Effect.retry(Schedule.spaced("1 second")),
				),
			);
			onCleanup(() => runtime.runFork(Fiber.interrupt(subscription)));
		}),
	);

	/** The entries of the desk shown; none while the previous desk's view is still up. */
	const entries = () => (state.view && (state.view.desk?.session ?? undefined) === session() ? state.view.entries : []);
	const mine = createMemo(() => waitingFor(entries(), "user"));
	const theirs = createMemo(() => waitingFor(entries(), "agent"));
	const yours = (entry: Entry) => waitingOn(entry) === "user";
	// Drafts are kept by the id of an entry on the desk, so their keys are entry ids.
	const pending = (): Array<{ entry: EntryId; text: string }> =>
		Object.entries(drafts).flatMap(([entry, text]) => (text?.trim() ? [{ entry: entry as EntryId, text }] : []));
	/** A draft as sent: its text and the attachments it still references. */
	const outgoing = async (draft: { entry: EntryId; text: string }): Promise<Draft> => ({
		...draft,
		files: await Attachments.outgoing(draft.text, (id) => files[id]),
	});
	const local: Local = (id) => files[id];
	/** Waiting on you, and you've started an answer: shown instead of the plain status. */
	const drafted = (entry: Entry) => yours(entry) && !!drafts[entry.id]?.trim();
	const byId = (id: string) => entries().find((entry) => entry.id === id);

	function notify(message: string, error = false) {
		const shown = { message, error };
		setToast(shown);
		setTimeout(() => toast() === shown && setToast(undefined), error ? 6000 : 2500);
	}
	const attempt = (action: () => Promise<string>) =>
		action().then(notify, (error: unknown) =>
			notify(isRefusal(error) ? refusal(error) : String((error as { message?: unknown })?.message ?? error), true),
		);

	/** Keeps the files with the draft and inserts their Markdown at `at` (default: the end); they're uploaded when it's sent. */
	const attach = (entry: string, added: ReadonlyArray<File>, at?: number) =>
		attempt(async () => {
			await loaded;
			const stored = added.map(
				(file): Attachments.Local => ({ id: newId(), name: file.name || "file", type: file.type, blob: file }),
			);
			await Promise.all(stored.map(Attachments.save));
			stored.forEach(keep);
			const markdown = stored.map(Attachments.link).join("\n");
			const text = drafts[entry] ?? "";
			const index = Math.min(at ?? text.length, text.length);
			const before = text.slice(0, index);
			setDrafts(entry, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${markdown}\n${text.slice(index)}`);
			return `Attached ${added.length} file${added.length === 1 ? "" : "s"}`;
		});

	const submit = () =>
		attempt(async () => {
			const sent = await Promise.all(pending().map(outgoing));
			const count = await call((client) => client.submit({ drafts: sent }));
			setDrafts(reconcile({}));
			await prune();
			return `Submitted ${count} draft${count === 1 ? "" : "s"}; queued for the agents`;
		});

	/** Whether the entry's session is out of desk mode: its text waits until the session turns it on. */
	const outOfDeskMode = (entry: Entry) => !state.view?.deskMode.includes(entry.session);
	/** Why the last try to deliver the entry's text failed, if it did. */
	const failure = (entry: Entry) => (entry.pending === null ? undefined : state.view?.failures[entry.pending.message]);
	/** Why the entry's text hasn't reached its session. */
	const undelivered = (entry: Entry) => {
		const failed = failure(entry);
		if (failed)
			return `Your text hasn't reached the session: the last try failed (${deliveryFailed(failed)}). It's tried again on every change, when an OpenCode connects, and every 30 s.`;
		return outOfDeskMode(entry)
			? "Your text hasn't reached the session yet: it isn't in desk mode, so it couldn't reply on the desk. It goes out when the session turns desk mode on."
			: "Your text hasn't reached the session yet: no connected OpenCode knows it. It goes out when one does.";
	};

	/** A desk whose session no connected OpenCode knows: it may be gone, and another session can claim its desk. */
	const Unknown = (props: { session: string }) => (
		<span
			class="label"
			title={`No connected OpenCode knows session ${props.session}: it may be gone. Answers to it wait until one does; another session can take this desk over (desk_claim ${props.session}).`}
		>
			unknown session
		</span>
	);

	const Pills = (props: { entry: Entry }) => (
		<>
			<span class={`pill ${drafted(props.entry) ? "drafted" : props.entry.status}`}>
				{drafted(props.entry) ? "drafted" : props.entry.status}
			</span>
			<Show when={props.entry.pending !== null}>
				<span class={`pill undelivered${failure(props.entry) ? " failed" : ""}`} title={undelivered(props.entry)}>
					{outOfDeskMode(props.entry) ? "waiting for desk mode" : "not delivered"}
				</span>
			</Show>
			<Show when={yours(props.entry)}>
				<span class="pill yours">your turn</span>
			</Show>
			<Show when={props.entry.labels.includes("review") && openUnder(entries(), props.entry).length}>
				{(count) => (
					<span class="below" title="Entries below this one that aren't resolved yet">
						{count()} open below
					</span>
				)}
			</Show>
		</>
	);

	function List() {
		const Section = (props: { title: string; entries: ReadonlyArray<Entry>; note?: string }) => (
			<Show when={props.entries.length > 0}>
				<div class="section">
					{props.title}
					<Show when={props.note}> · {props.note}</Show>
				</div>
				<div class="list">
					<For each={props.entries}>
						{(entry) => (
							<A
								class={`item${yours(entry) ? " turn" : ""}${entry.priority === "low" ? " low" : ""}${entry.priority === "critical" ? " critical" : ""}`}
								href={entryOnDesk(entry.id)}
							>
								<span class="id">#{shortId(entry.id)}</span>
								<Show when={entry.priority === "critical"}>
									<span class="crit" title="Critical: blocking work right now">
										▲▲
									</span>
								</Show>
								<Show when={entry.priority === "high"}>
									<span class="high" title="High priority">
										▲
									</span>
								</Show>
								<span class="title">{entry.title}</span>
								<Pills entry={entry} />
							</A>
						)}
					</For>
				</div>
			</Show>
		);
		return (
			<Show when={session() !== undefined} fallback={<Desks />}>
				<Show when={entries().length > 0} fallback={<div class="empty">The desk is empty.</div>}>
					<Section
						title="Waiting on you"
						entries={mine()}
						note={`${mine().filter(drafted).length} of ${mine().length} drafted`}
					/>
					<Section title="Waiting on the agents" entries={theirs()} />
					<Section title="Resolved" entries={ordered(entries()).filter((entry) => entry.status === "resolved")} />
				</Show>
			</Show>
		);
	}

	/** No desk picked: every session's desk with entries. */
	function Desks() {
		return (
			<Show when={(state.view?.desks.length ?? 0) > 0} fallback={<div class="empty">No desk has entries yet.</div>}>
				<div class="section">Desks</div>
				<div class="list">
					<For each={state.view?.desks ?? []}>
						{(other) => (
							<A class={`item${other.waiting ? " turn" : ""}`} href={deskPath(other.session)}>
								<span class="title">{deskName(other)}</span>
								<Show when={!other.known}>
									<Unknown session={other.session} />
								</Show>
								<Show when={other.critical}>
									<span class="crit" title="Critical: blocking work right now">
										▲▲ {other.critical}
									</span>
								</Show>
								<Show when={other.waiting}>
									<span class="pill yours">{other.waiting} waiting on you</span>
								</Show>
							</A>
						)}
					</For>
				</div>
			</Show>
		);
	}

	function EntryView() {
		const params = useParams<{ id: string }>();
		const navigate = useNavigate();
		const entry = () => byId(params.id);
		/** Where this entry sat in the order; still known after it leaves the desk, so Next goes on from here. */
		const place = createMemo<Pick<Entry, "parent" | "created" | "priority">>(
			(previous) => {
				const now = entry();
				return now ? { parent: now.parent, created: now.created, priority: now.priority } : previous;
			},
			{ parent: null, created: "", priority: "normal" },
		);
		const goNext = () => {
			// Only compared with the entries' ids: a bad one in the URL is simply not among them.
			const following = next(entries(), { id: params.id as EntryId, ...place() });
			navigate(following ? entryOnDesk(following.id) : home());
		};
		/** Submits every draft, like the header's Submit, then goes on. Next (Shift) leaves them in the browser instead. */
		const sendAndNext = () => {
			if (pending().length > 0) void submit();
			goNext();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
			if (event.shiftKey) goNext();
			else sendAndNext();
		};
		window.addEventListener("keydown", onKey);
		onCleanup(() => window.removeEventListener("keydown", onKey));
		// Files dropped anywhere on the window join this entry's draft, when it has a draft box.
		const [dragging, setDragging] = createSignal(false);
		const droppable = (event: DragEvent) =>
			entry()?.status !== "resolved" && !!event.dataTransfer?.types.includes("Files");
		const drag = (event: DragEvent) => {
			if (!droppable(event)) return;
			event.preventDefault();
			setDragging(event.type !== "dragleave" || event.relatedTarget !== null);
		};
		const drop = (event: DragEvent) => {
			setDragging(false);
			if (!droppable(event)) return;
			event.preventDefault();
			void attach(params.id, [...(event.dataTransfer?.files ?? [])]);
		};
		const events = { dragenter: drag, dragover: drag, dragleave: drag, drop } as const;
		for (const [name, handler] of Object.entries(events)) window.addEventListener(name, handler as EventListener);
		onCleanup(() => {
			for (const [name, handler] of Object.entries(events)) window.removeEventListener(name, handler as EventListener);
		});
		return (
			<>
				<Show when={dragging()}>
					<div class="dropzone">Drop to attach</div>
				</Show>
				{/* Beside the entry and sticky: back on the left, its actions stacked on the right (above it on a narrow window). */}
				<div class="entry-layout">
					<aside class="side left">
						<A href={home()}>← All entries</A>
					</aside>
					<aside class="side right">
						<button
							type="button"
							class="secondary"
							title={params.id}
							onClick={() => void attempt(() => navigator.clipboard.writeText(params.id).then(() => "Id copied"))}
						>
							<Icon name="copy" /> Copy id
						</button>
						<button
							type="button"
							class="primary"
							title="Go to the next entry, leaving this one and its draft as they are (Ctrl+Shift+Enter)"
							onClick={goNext}
						>
							Next <Icon name="next" /> <small class="keys">⇧⌘↵</small>
						</button>
					</aside>
					<Show when={entry()} fallback={<div class="empty">#{shortId(params.id)} is no longer on the desk.</div>}>
						{(entry) => {
							const parent = () => {
								const id = entry().parent;
								return id === null ? undefined : byId(id);
							};
							const children = () => entries().filter((other) => other.parent === entry().id);
							const further = () => openBelow(entries(), entry());
							let picker: HTMLInputElement | undefined;
							return (
								<div class={`card${yours(entry()) ? " turn" : ""}`}>
									<div class="head">
										<span class="id">#{shortId(entry().id)}</span>
										<Show when={entry().priority === "critical"}>
											<span class="crit" title="Critical: blocking work right now">
												▲▲
											</span>
										</Show>
										<Show when={entry().priority === "high"}>
											<span class="high" title="High priority">
												▲
											</span>
										</Show>
										<span class="title">{entry().title}</span>
										<Pills entry={entry()} />
										<For each={entry().labels}>{(label) => <span class="label">{label}</span>}</For>
									</div>
									<div class="muted">{entry().asker === "agent" ? "agents → you" : "you → agents"}</div>
									<Show when={failure(entry())}>
										{(reason) => (
											<div class="failure">
												Not delivered: the last try failed: {deliveryFailed(reason())}. It's tried again on every
												change, when an OpenCode connects, and every 30 s.
											</div>
										)}
									</Show>
									<Show when={entry().pending !== null}>
										<div class="undelivered-actions">
											<span class="muted">
												{outOfDeskMode(entry())
													? "Your text waits for its session to turn desk mode on."
													: "Your text hasn't reached its session yet."}
											</span>
											<button
												type="button"
												class="link"
												title="Stop trying to deliver it, e.g. when its session was deleted. The text stays on the entry, and the entry can be resolved."
												onClick={() => {
													const id = entry().id;
													if (
														!confirm(
															"Stop delivering your text? It stays on the entry, but its session never receives it. Anything sent in the same message is dropped too.",
														)
													)
														return;
													void attempt(() =>
														call((client) => client.discard({ entry: id })).then(
															() => `#${shortId(id)}: delivery discarded`,
														),
													);
												}}
											>
												Discard delivery
											</button>
										</div>
									</Show>
									<Show when={parent()}>
										{(parent) => (
											<div class="relation">
												Follow-up to{" "}
												<A href={entryOnDesk(parent().id)}>
													#{shortId(parent().id)} {parent().title}
												</A>{" "}
												<Pills entry={parent()} />
											</div>
										)}
									</Show>
									<div class="body">
										<Markdown text={entry().question} entry={entry().id} />
									</div>
									<Show when={entry().answer}>
										{(answer) => (
											<div class="answer">
												<div class="caption">Answer from {entry().asker === "agent" ? "you" : "the agents"}</div>
												<Markdown text={answer()} entry={entry().id} />
											</div>
										)}
									</Show>
									<Show when={entry().status !== "resolved"}>
										<div class="actions">
											<textarea
												placeholder={
													entry().asker === "agent" && entry().status === "open"
														? "Your answer (Markdown)"
														: "A follow-up question (Markdown)"
												}
												value={drafts[entry().id] ?? ""}
												onInput={(event) => setDrafts(entry().id, event.currentTarget.value)}
												onPaste={(event) => {
													const files = [...(event.clipboardData?.files ?? [])];
													if (files.length === 0) return;
													event.preventDefault();
													void attach(entry().id, files, event.currentTarget.selectionStart);
												}}
											/>
											<Show when={Attachments.referenced(drafts[entry().id] ?? "").size > 0}>
												<div class="preview">
													<div class="caption">Preview</div>
													<Markdown text={drafts[entry().id] ?? ""} entry={entry().id} local={local} />
												</div>
											</Show>
											<div class="row">
												<input
													ref={picker}
													type="file"
													multiple
													hidden
													onChange={(event) => {
														const input = event.currentTarget;
														void attach(entry().id, [...(input.files ?? [])]).then(() => (input.value = ""));
													}}
												/>
												<button
													type="button"
													class="secondary"
													title="Attach files, or paste or drop them into the box"
													onClick={() => picker?.click()}
												>
													<Icon name="attach" /> Attach
												</button>
												<button
													type="button"
													class="secondary"
													title="Urgent: deliver now, steering the session's current turn"
													disabled={!drafts[entry().id]?.trim()}
													onClick={() => {
														const draft = { entry: entry().id, text: drafts[entry().id] ?? "" };
														void attempt(async () => {
															const sent = await outgoing(draft);
															await call((client) => client.send(sent));
															setDrafts(draft.entry, undefined);
															await prune();
															return "Sent to the agents";
														});
													}}
												>
													<Icon name="now" /> Send now
												</button>
												<Show when={entry().asker === "user"}>
													<button
														type="button"
														class="secondary"
														onClick={() => {
															const id = entry().id;
															void attempt(() =>
																call((client) => client.resolve({ by: { _tag: "User" }, id })).then(
																	() => `#${shortId(id)} marked done`,
																),
															);
														}}
													>
														<Icon name="done" /> Mark done
													</button>
												</Show>
												<span class="spacer" />
												<button
													type="button"
													class="primary"
													title="Submit all drafts, then go to the next entry (Ctrl+Enter)"
													onClick={sendAndNext}
												>
													<Icon name="send" /> Send & next <small class="keys">⌘↵</small>
												</button>
											</div>
										</div>
									</Show>
									<Show when={children().length > 0}>
										<div class="children">
											<div class="caption">Follow-ups</div>
											<ul>
												<For each={children()}>
													{(child) => (
														<li>
															<A href={entryOnDesk(child.id)}>
																#{shortId(child.id)} {child.title}
															</A>{" "}
															<Pills entry={child} />
														</li>
													)}
												</For>
											</ul>
										</div>
									</Show>
									<Show when={further().length > 0}>
										<div class="children">
											<div class="caption">Open further down</div>
											<ul>
												<For each={further()}>
													{(deep) => (
														<li>
															<A href={entryOnDesk(deep.id)}>
																#{shortId(deep.id)} {deep.title}
															</A>{" "}
															<Pills entry={deep} />
															<Show when={deep.parent === null ? undefined : byId(deep.parent)}>
																{(parent) => (
																	<span class="muted">
																		{" "}
																		· under #{shortId(parent().id)} {parent().title}
																	</span>
																)}
															</Show>
														</li>
													)}
												</For>
											</ul>
										</div>
									</Show>
								</div>
							);
						}}
					</Show>
				</div>
			</>
		);
	}

	const Shell = (props: ParentProps) => {
		const navigate = useNavigate();
		const route = useLocation();
		createEffect(() => setSession(sessionIn(route.pathname)));
		// Desks used to be per project: an old link goes to the list.
		createEffect(() => {
			if (route.pathname.startsWith("/projects/")) navigate("/", { replace: true });
		});
		return (
			<Show when={state.view} fallback={<div class="empty">Connecting…</div>}>
				{(view) => (
					<>
						<header>
							<div class="bar">
								<h1>
									<A href="/">Desk</A>
								</h1>
								<Show
									when={view().desks.length > 1 || view().desk}
									fallback={<span class="muted">{deskName(view().desk)}</span>}
								>
									<select
										ref={(select) =>
											createEffect(() => {
												// After the options for this view exist: a value set before them doesn't stick.
												void view().desks.length;
												const id = session() ?? "";
												queueMicrotask(() => (select.value = id));
											})
										}
										class="project"
										title="Each session has its own desk (its subagents share it)"
										onChange={(event) =>
											navigate(event.currentTarget.value ? deskPath(event.currentTarget.value) : "/")
										}
									>
										<Show when={session() === undefined}>
											<option value="" selected>
												Choose a desk
											</option>
										</Show>
										<Show when={view().desk && !view().desks.some((other) => other.session === session())}>
											<option value={session()} selected>
												{deskName(view().desk)}
											</option>
										</Show>
										<For each={view().desks}>
											{(other) => (
												<option value={other.session} selected={other.session === session()}>
													{deskName(other)}
													{other.known ? "" : " (unknown session)"}
													{other.session !== session() && other.waiting ? ` (${other.waiting})` : ""}
												</option>
											)}
										</For>
									</select>
								</Show>
								<span class="spacer" />
								<span
									class={`connection${view().deskMode.length === 0 ? " none" : ""}`}
									title="Sessions with desk mode on (/desk-mode). Answers go out through their OpenCode; with none, answers wait until one is on again."
								>
									{view().deskMode.length === 0
										? "No session in desk mode"
										: `${view().deskMode.length} ${view().deskMode.length === 1 ? "session" : "sessions"} in desk mode`}
								</span>
								<Show when={!state.online}>
									<span class="offline">reconnecting…</span>
								</Show>
								<button
									type="button"
									class="primary"
									disabled={pending().length === 0}
									title="Send every draft, one queued message per session"
									onClick={submit}
								>
									<Icon name="send" />{" "}
									{pending().length ? `Submit ${pending().length} draft${pending().length === 1 ? "" : "s"}` : "Submit"}
								</button>
							</div>
						</header>
						<main>
							<Show when={view().deskMode.length === 0 || view().desk?.known === false}>
								<div class="notice">
									<Show when={view().deskMode.length === 0}>
										No session is in desk mode: answers wait as <em>not delivered</em> until one is.{" "}
									</Show>
									<Show when={view().desk?.known === false}>
										No connected OpenCode knows this desk's session ({view().desk?.session}): it may be gone. Answers to
										it wait; another session can take this desk over with <code>desk_claim</code>.
									</Show>
								</div>
							</Show>
							{props.children}
						</main>
						<Show when={toast()} keyed>
							{(toast) => <div class={`toast${toast.error ? " error" : ""}`}>{toast.message}</div>}
						</Show>
					</>
				)}
			</Show>
		);
	};

	return (
		<MetaProvider>
			<Title>{`${mine().length ? `(${mine().length}) ` : ""}${state.view?.desk ? `${deskName(state.view.desk)} · ` : ""}Desk`}</Title>
			<Router root={Shell}>
				<Route path={[...patterns.list]} component={List} />
				<Route path={patterns.entry} component={EntryView} />
			</Router>
		</MetaProvider>
	);
}

render(() => <App />, document.body);
