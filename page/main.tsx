/** @jsxImportSource solid-js */
/**
 * The desk page: one project's desk (`?project=<id>`; without one, the list of projects), its open entries as a flat
 * list, and an entry view with its parent, follow-ups, a draft box and Next.
 * Drafts live in the browser until Submit (all of them, one message per session), ⌘↵ (the same, then Next) or Send now (one, steering).
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { MetaProvider, Title } from "@solidjs/meta";
import { A, HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, type ParentProps, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { DeskApi, type Draft, type View } from "../src/page-api";
import { type Entry, newId, next, openBelow, openUnder, ordered, shortId, waitingFor, waitingOn } from "../src/entry";
import * as Attachments from "./attachments";
import { type Local, render as markdown, renderDiagrams } from "./markdown";

const runtime = ManagedRuntime.make(
	RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])),
);
const client = RpcClient.make(DeskApi);
const withClient = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(client, f));
/** Calls the desk; rejects with the desk's message. */
const call = <A, E>(f: (desk: Effect.Success<typeof client>) => Effect.Effect<A, E>) => runtime.runPromise(withClient(f));

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

/** The project this page shows; drafts are kept per project. */
const project = new URLSearchParams(location.search).get("project") ?? undefined;
const draftsKey = `desk.drafts.${project ?? ""}`;

function Markdown(props: { text: string; entry: string; local?: Local }) {
	let container!: HTMLDivElement;
	createEffect(() => {
		container.innerHTML = markdown(props.text, `/files/${props.entry}/`, props.local);
		void renderDiagrams(container);
	});
	return <div class="md" ref={container} />;
}

function App() {
	const [state, setState] = createStore<{ view: View | null; online: boolean }>({ view: null, online: true });
	const [drafts, setDrafts] = createStore<Record<string, string>>(JSON.parse(localStorage.getItem(draftsKey) ?? "{}"));
	const [toast, setToast] = createSignal<{ message: string; error: boolean }>();
	createEffect(() => localStorage.setItem(draftsKey, JSON.stringify(drafts)));
	/** The drafts' attachments, with object URLs for their previews; the files themselves wait in IndexedDB until sent. */
	const [files, setFiles] = createStore<Record<string, Attachments.Local & { url: string }>>({});
	const keep = (file: Attachments.Local) => setFiles(file.id, { ...file, url: URL.createObjectURL(file.blob) });
	/** Lets go of the attachments no draft references anymore: those just sent, those whose draft went, and links deleted from the text. */
	const prune = () => {
		const used = new Set(Object.values(drafts).flatMap((text) => [...Attachments.referenced(text ?? "")]));
		const unused = Object.keys(files).filter((id) => !used.has(id));
		for (const id of unused) {
			URL.revokeObjectURL(files[id]!.url);
			setFiles(id, undefined!);
		}
		return Attachments.remove(unused);
	};
	const loaded = Attachments.all()
		.then((stored) => {
			for (const file of stored) keep(file);
			return prune();
		})
		.catch(() => {});

	const subscription = runtime.runFork(
		withClient((desk) =>
			desk.view({ project }).pipe(
				Stream.runForEach((view) =>
					Effect.sync(() => {
						setState("online", true);
						setState("view", reconcile(view, { key: "id", merge: true }));
						// A draft for an entry that left the desk can't be sent anymore.
						const gone = Object.keys(drafts).filter((id) => !view.entries.some((entry) => entry.id === id));
						for (const id of gone) setDrafts(id, undefined!);
						if (gone.length > 0) void loaded.then(prune);
					}),
				),
			),
		).pipe(Effect.tapError(() => Effect.sync(() => setState("online", false))), Effect.retry(Schedule.spaced("1 second"))),
	);
	onCleanup(() => runtime.runFork(Fiber.interrupt(subscription)));

	const entries = () => state.view?.entries ?? [];
	/** Blocked entries (an unresolved follow-up below) are in neither group: their follow-ups are. */
	const mine = createMemo(() => waitingFor(entries(), "user"));
	const theirs = createMemo(() => waitingFor(entries(), "agent"));
	const yours = (entry: Entry) => waitingOn(entry, entries()) === "user";
	const pending = (): Array<{ entry: string; text: string }> => Object.entries(drafts).flatMap(([entry, text]) => (text?.trim() ? [{ entry, text }] : []));
	/** A draft as sent: its text and the attachments it still references. */
	const outgoing = async (draft: { entry: string; text: string }): Promise<Draft> => ({ ...draft, files: await Attachments.outgoing(draft.text, (id) => files[id]) });
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
		action().then(notify, (error: { message?: string }) => notify(error.message ?? String(error), true));

	/** Keeps the files with the draft and inserts their Markdown at `at` (default: the end); they're uploaded when it's sent. */
	const attach = (entry: string, added: ReadonlyArray<File>, at?: number) =>
		attempt(async () => {
			await loaded;
			const stored = added.map((file): Attachments.Local => ({ id: newId(), name: file.name || "file", type: file.type, blob: file }));
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

	const Pills = (props: { entry: Entry }) => (
		<>
			<span class={`pill ${drafted(props.entry) ? "drafted" : props.entry.status}`}>{drafted(props.entry) ? "drafted" : props.entry.status}</span>
			<Show when={props.entry.outbox !== null}>
				<span class="pill undelivered" title="Your text hasn't reached the session yet: its OpenCode isn't connected. It goes out when it is.">not delivered</span>
			</Show>
			<Show when={yours(props.entry)}>
				<span class="pill yours">your turn</span>
			</Show>
			<Show when={props.entry.labels.includes("review") && openUnder(entries(), props.entry).length}>
				{(count) => <span class="below" title="Entries below this one that aren't resolved yet">{count()} open below</span>}
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
							<A class={`item${yours(entry) ? " turn" : ""}${entry.priority === "low" ? " low" : ""}${entry.priority === "critical" ? " critical" : ""}`} href={`/${entry.id}`}>
								<span class="id">#{shortId(entry.id)}</span>
								<Show when={entry.priority === "critical"}>
									<span class="crit" title="Critical: blocking work right now">▲▲</span>
								</Show>
								<Show when={entry.priority === "high"}>
									<span class="high" title="High priority">▲</span>
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
			<Show when={project !== undefined} fallback={<Projects />}>
			<Show when={entries().length > 0} fallback={<div class="empty">The desk is empty.</div>}>
				<Section title="Waiting on you" entries={mine()} note={`${mine().filter(drafted).length} of ${mine().length} drafted`} />
				<Section title="Waiting on the agents" entries={theirs()} />
				<Section title="Resolved" entries={ordered(entries()).filter((entry) => entry.status === "resolved")} />
			</Show>
			</Show>
		);
	}

	/** No project picked: every project with entries, each its own desk. */
	function Projects() {
		return (
			<Show when={(state.view?.projects.length ?? 0) > 0} fallback={<div class="empty">No desk has entries yet.</div>}>
				<div class="section">Projects</div>
				<div class="list">
					<For each={state.view!.projects}>
						{(other) => (
							<a class={`item${other.waiting ? " turn" : ""}`} href={`?project=${encodeURIComponent(other.id)}`}>
								<span class="title">{other.name}</span>
								<Show when={other.critical}>
									<span class="crit" title="Critical: blocking work right now">▲▲ {other.critical}</span>
								</Show>
								<Show when={other.waiting}>
									<span class="pill yours">{other.waiting} waiting on you</span>
								</Show>
							</a>
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
		const place = createMemo<Pick<Entry, "parent" | "created" | "priority">>((previous) => (entry() ? { parent: entry()!.parent, created: entry()!.created, priority: entry()!.priority } : previous), { parent: null, created: "", priority: "normal" });
		const goNext = () => navigate(`/${next(entries(), { id: params.id, ...place() })?.id ?? ""}`);
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
		const droppable = (event: DragEvent) => entry()?.status !== "resolved" && !!event.dataTransfer?.types.includes("Files");
		const drag = (event: DragEvent) => {
			if (!droppable(event)) return;
			event.preventDefault();
			setDragging(event.type !== "dragleave" || event.relatedTarget !== null);
		};
		const drop = (event: DragEvent) => {
			setDragging(false);
			if (!droppable(event)) return;
			event.preventDefault();
			void attach(params.id, [...event.dataTransfer!.files]);
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
				<div class="nav">
					<A href="/">← All entries</A>
					<span class="spacer" />
					<button class="secondary" title={params.id} onClick={() => void attempt(() => navigator.clipboard.writeText(params.id).then(() => "Id copied"))}>
						<Icon name="copy" /> Copy id
					</button>
					<button class="primary" title="Go to the next entry, leaving this one and its draft as they are (Ctrl+Shift+Enter)" onClick={goNext}>
						Next <Icon name="next" /> <small class="keys">⇧⌘↵</small>
					</button>
				</div>
				<Show when={entry()} fallback={<div class="empty">#{shortId(params.id)} is no longer on the desk.</div>}>
					{(entry) => {
						const parent = () => (entry().parent === null ? undefined : byId(entry().parent!));
						const children = () => entries().filter((other) => other.parent === entry().id);
						const further = () => openBelow(entries(), entry());
						let picker!: HTMLInputElement;
						return (
							<div class={`card${yours(entry()) ? " turn" : ""}`}>
								<div class="head">
									<span class="id">#{shortId(entry().id)}</span>
									<Show when={entry().priority === "critical"}>
										<span class="crit" title="Critical: blocking work right now">▲▲</span>
									</Show>
									<Show when={entry().priority === "high"}>
										<span class="high" title="High priority">▲</span>
									</Show>
									<span class="title">{entry().title}</span>
									<Pills entry={entry()} />
									<For each={entry().labels}>{(label) => <span class="label">{label}</span>}</For>
								</div>
								<div class="muted">{entry().asker === "agent" ? "agents → you" : "you → agents"}</div>
								<Show when={parent()}>
									{(parent) => (
										<div class="relation">
											Follow-up to <A href={`/${parent().id}`}>#{shortId(parent().id)} {parent().title}</A> <Pills entry={parent()} />
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
											placeholder={entry().asker === "agent" && entry().status === "open" ? "Your answer (Markdown)" : "A follow-up question (Markdown)"}
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
													void attach(entry().id, [...input.files!]).then(() => (input.value = ""));
												}}
											/>
											<button class="secondary" title="Attach files, or paste or drop them into the box" onClick={() => picker.click()}>
												<Icon name="attach" /> Attach
											</button>
											<button
												class="secondary"
												title="Urgent: deliver now, steering the session's current turn"
												onClick={() => {
													const draft = { entry: entry().id, text: drafts[entry().id] ?? "" };
													void attempt(async () => {
														const sent = await outgoing(draft);
														await call((client) => client.send(sent));
														setDrafts(draft.entry, undefined!);
														await prune();
														return "Sent to the agents";
													});
												}}
											>
												<Icon name="now" /> Send now
											</button>
											<Show when={entry().asker === "user"}>
												<button
													class="secondary"
													onClick={() => {
														const id = entry().id;
														void attempt(() => call((client) => client.resolve({ id })).then(() => `#${shortId(id)} marked done`));
													}}
												>
													<Icon name="done" /> Mark done
												</button>
											</Show>
											<span class="spacer" />
											<button class="primary" title="Submit all drafts, then go to the next entry (Ctrl+Enter)" onClick={sendAndNext}>
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
														<A href={`/${child.id}`}>
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
														<A href={`/${deep.id}`}>
															#{shortId(deep.id)} {deep.title}
														</A>{" "}
														<Pills entry={deep} />
														<Show when={byId(deep.parent!)}>{(parent) => <span class="muted"> · under #{shortId(parent().id)} {parent().title}</span>}</Show>
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
			</>
		);
	}

	const Shell = (props: ParentProps) => (
		<Show when={state.view} fallback={<div class="empty">Connecting…</div>}>
			<header>
				<div class="bar">
					<h1>
						<A href="/">Desk</A>
					</h1>
					<Show when={state.view!.projects.length > 1 || state.view!.project} fallback={<span class="muted">{state.view!.project?.name}</span>}>
						<select
							ref={(select) => createEffect(() => {
								// After the options for this view exist: a value set before them doesn't stick.
								void state.view!.projects.length;
								queueMicrotask(() => (select.value = project ?? ""));
							})}
							class="project"
							title="Each project has its own desk"
							onChange={(event) => location.assign(event.currentTarget.value ? `?project=${encodeURIComponent(event.currentTarget.value)}` : "?")}
						>
							<Show when={project === undefined}>
								<option value="" selected>Choose a project</option>
							</Show>
							<Show when={state.view!.project && !state.view!.projects.some((other) => other.id === project)}>
								<option value={project} selected>{state.view!.project!.name}</option>
							</Show>
							<For each={state.view!.projects}>
								{(other) => (
									<option value={other.id} selected={other.id === project}>
										{other.name}
										{other.id !== project && other.waiting ? ` (${other.waiting})` : ""}
									</option>
								)}
							</For>
						</select>
					</Show>
					<span class="spacer" />
					<Show when={!state.online}>
						<span class="offline">reconnecting…</span>
					</Show>
					<button class="primary" disabled={pending().length === 0} title="Send every draft, one queued message per session" onClick={submit}>
						<Icon name="send" /> {pending().length ? `Submit ${pending().length} draft${pending().length === 1 ? "" : "s"}` : "Submit"}
					</button>
				</div>
			</header>
			<main>{props.children}</main>
			<Show when={toast()} keyed>
				{(toast) => <div class={`toast${toast.error ? " error" : ""}`}>{toast.message}</div>}
			</Show>
		</Show>
	);

	return (
		<MetaProvider>
			<Title>{`${mine().length ? `(${mine().length}) ` : ""}${state.view?.project ? `${state.view.project.name} · ` : ""}Desk`}</Title>
			<HashRouter root={Shell}>
				<Route path="/" component={List} />
				<Route path="/:id" component={EntryView} />
			</HashRouter>
		</MetaProvider>
	);
}

render(() => <App />, document.body);
