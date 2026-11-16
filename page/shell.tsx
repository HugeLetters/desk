/** @jsxImportSource solid-js */
import { Title } from "@solidjs/meta";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, For, type ParentProps, Show } from "solid-js";
import { deskPath, sessionIn } from "../src/api/routes";
import { Icon } from "./components/icon";
import { createDesk, DeskProvider } from "./desk";
import { deskName } from "./session";

/** What the page says while the service doesn't let this browser in. */
const notLetIn =
	"The desk doesn't let this browser in any more: open it from OpenCode once (/desk-mode's link, or the footer's desk badge).";

/**
 * The layout every route is in: the desk the URL shows (`/sessions/<id>/…`; none on the list of desks), its view and
 * drafts for the routes below (`useDesk`), the header (desks, desk mode, Submit), the notices, and the toast.
 */
export const Shell = (props: ParentProps) => {
	const navigate = useNavigate();
	const route = useLocation();
	const session = createMemo(() => sessionIn(route.pathname));
	const desk = createDesk(session);
	const mine = () => desk.view.mine().length;
	const named = () => desk.view.state.view?.desk;

	// Desks used to be per project: an old link goes to the list.
	createEffect(() => {
		if (route.pathname.startsWith("/projects/")) navigate("/", { replace: true });
	});
	return (
		<DeskProvider desk={desk}>
			<Title>{`${mine() ? `(${mine()}) ` : ""}${named() ? `${deskName(named())} · ` : ""}Desk`}</Title>
			<Show
				when={desk.view.state.view}
				fallback={<div class="empty">{desk.view.state.letIn ? "Connecting…" : notLetIn}</div>}
			>
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
								<Show when={!desk.view.state.online}>
									<span class="offline">{desk.view.state.letIn ? "reconnecting…" : "not let in"}</span>
								</Show>
								<button
									type="button"
									class="primary"
									disabled={desk.drafts.pending().length === 0}
									title="Send every draft, one queued message per session"
									onClick={desk.submit}
								>
									<Icon name="send" />{" "}
									{desk.drafts.pending().length
										? `Submit ${desk.drafts.pending().length} draft${desk.drafts.pending().length === 1 ? "" : "s"}`
										: "Submit"}
								</button>
							</div>
						</header>
						<main>
							<Show when={!desk.view.state.letIn}>
								<div class="notice">{notLetIn}</div>
							</Show>
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
						<Show when={desk.toast.toast()} keyed>
							{(toast) => <div class={`toast${toast.error ? " error" : ""}`}>{toast.message}</div>}
						</Show>
					</>
				)}
			</Show>
		</DeskProvider>
	);
};
