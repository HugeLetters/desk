/** @jsxImportSource solid-js */
import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { deskPath } from "../../src/api/routes";
import { Unknown } from "../components/pills";
import { useDesk } from "../desk";
import { deskName } from "../session";

/** No desk picked: every session's desk with entries. */
export function Desks() {
	const { view } = useDesk();
	return (
		<Show
			when={(view.state.view?.desks.length ?? 0) > 0}
			fallback={<div class="empty">No desks yet: a session has one once it turns desk mode on or asks.</div>}
		>
			<div class="section">Desks</div>
			<div class="list">
				<For each={view.state.view?.desks ?? []}>
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
