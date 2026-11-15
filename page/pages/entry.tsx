/** @jsxImportSource solid-js */
import { A, useNavigate, useParams } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { entryPath } from "../../src/api/routes";
import { type Entry, type EntryId, next, openBelow, shortId } from "../../src/model/entry";
import { deliveryFailed } from "../../src/model/wording";
import * as Attachments from "../attachments";
import { Icon } from "../components/icon";
import { Markdown } from "../components/markdown";
import { Pills, Priority } from "../components/pills";
import { useDesk, yours } from "../desk";
import * as Rpc from "../rpc";
import { home } from "../session";

/** One entry: its parent, the entry, its draft box, its follow-ups and what's open further down; Next goes on. */
export function EntryView() {
	const desk = useDesk();
	const { view, drafts, files, toast } = desk;
	const params = useParams<{ session: string; id: string }>();
	const navigate = useNavigate();
	/** An entry on this entry's desk (the route's session, decoded as `sessionIn` does). */
	const entryOnDesk = (id: string) => entryPath(decodeURIComponent(params.session), id);
	const entry = () => view.byId(params.id);
	/** Where this entry sat in the order; still known after it leaves the desk, so Next goes on from here. */
	const place = createMemo<Pick<Entry, "parent" | "created" | "priority">>(
		(previous) => {
			const now = entry();
			return now ? { parent: now.parent, created: now.created, priority: now.priority } : previous;
		},
		{ parent: null, created: "", priority: "normal" },
	);
	/**
	 * The next entry waiting on the user, past the ones they've already written to (`drafted`): those are answered as
	 * far as they're concerned, whether the drafts wait in the browser or were just submitted and the desk doesn't
	 * show it yet. None: the desk.
	 */
	const goNext = (drafted: ReadonlySet<string> = new Set(drafts.pending().map((draft) => draft.entry))) => {
		// Only compared with the entries' ids: a bad one in the URL is simply not among them.
		const following = next(
			view.entries().filter((other) => !drafted.has(other.id)),
			{ id: params.id as EntryId, ...place() },
		);
		navigate(following ? entryOnDesk(following.id) : home());
	};
	/** Submits every draft, like the header's Submit, then goes on. Next (Shift) leaves them in the browser instead. */
	const sendAndNext = () => {
		const drafted = new Set(drafts.pending().map((draft) => draft.entry));
		if (drafted.size > 0) void desk.submit();
		goNext(drafted);
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
		void desk.attach(params.id, [...(event.dataTransfer?.files ?? [])]);
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
						onClick={() => void toast.attempt(() => navigator.clipboard.writeText(params.id).then(() => "Id copied"))}
					>
						<Icon name="copy" /> Copy id
					</button>
					<button
						type="button"
						class="primary"
						title="Go to the next entry, leaving this one and its draft as they are (Ctrl+Shift+Enter)"
						onClick={() => goNext()}
					>
						Next <Icon name="next" /> <small class="keys">⇧⌘↵</small>
					</button>
				</aside>
				<Show when={entry()} fallback={<div class="empty">#{shortId(params.id)} is no longer on the desk.</div>}>
					{(entry) => {
						const parent = () => {
							const id = entry().parent;
							return id === null ? undefined : view.byId(id);
						};
						const children = () => view.entries().filter((other) => other.parent === entry().id);
						const further = () => openBelow(view.entries(), entry());
						let picker: HTMLInputElement | undefined;
						return (
							<div class={`card${yours(entry()) ? " turn" : ""}`}>
								<div class="head">
									<span class="id">#{shortId(entry().id)}</span>
									<Priority entry={entry()} />
									<span class="title">{entry().title}</span>
									<Pills entry={entry()} />
									<For each={entry().labels}>{(label) => <span class="label">{label}</span>}</For>
								</div>
								<div class="muted">{entry().asker === "agent" ? "agents → you" : "you → agents"}</div>
								<Show when={view.failure(entry())}>
									{(reason) => (
										<div class="failure">
											Not delivered: the last try failed: {deliveryFailed(reason())}. It's tried again on every change,
											when an OpenCode connects, and every 30 s.
										</div>
									)}
								</Show>
								<Show when={entry().pending !== null}>
									<div class="undelivered-actions">
										<span class="muted">
											{view.outOfDeskMode(entry())
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
												void toast.attempt(() =>
													Rpc.call((client) => client.discard({ entry: id })).then(
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
											value={drafts.drafts[entry().id] ?? ""}
											onInput={(event) => drafts.setDrafts(entry().id, event.currentTarget.value)}
											onPaste={(event) => {
												const files = [...(event.clipboardData?.files ?? [])];
												if (files.length === 0) return;
												event.preventDefault();
												void desk.attach(entry().id, files, event.currentTarget.selectionStart);
											}}
										/>
										<Show when={Attachments.referenced(drafts.drafts[entry().id] ?? "").size > 0}>
											<div class="preview">
												<div class="caption">Preview</div>
												<Markdown text={drafts.drafts[entry().id] ?? ""} entry={entry().id} local={files.local} />
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
													void desk.attach(entry().id, [...(input.files ?? [])]).then(() => (input.value = ""));
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
												disabled={!drafts.drafts[entry().id]?.trim()}
												onClick={() => void desk.sendNow(entry())}
											>
												<Icon name="now" /> Send now
											</button>
											<Show when={entry().asker === "user"}>
												<button
													type="button"
													class="secondary"
													onClick={() => {
														const id = entry().id;
														void toast.attempt(() =>
															Rpc.call((client) => client.resolve({ by: { _tag: "User" }, id })).then(
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
														<Show when={deep.parent === null ? undefined : view.byId(deep.parent)}>
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
