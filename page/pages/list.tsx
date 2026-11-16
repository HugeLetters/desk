/** @jsxImportSource solid-js */
import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { entryPath } from "../../src/api/routes";
import { type Entry, ordered, shortId } from "../../src/model/entry";
import { Pills, Priority } from "../components/pills";
import { useDesk, yours } from "../desk";
import { Desks } from "./desks";

/** Entries of `desk`, under a title, linked; none: nothing shown. */
function Section(props: { desk: string; title: string; entries: ReadonlyArray<Entry>; note?: string }) {
	return (
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
							href={entryPath(props.desk, entry.id)}
						>
							<span class="id">#{shortId(entry.id)}</span>
							<Priority entry={entry} />
							<span class="title">{entry.title}</span>
							<Pills entry={entry} />
						</A>
					)}
				</For>
			</div>
		</Show>
	);
}

/** The desk's entries: waiting on you, on the agents, resolved. Without a desk, the desks. */
export function List() {
	const { session, view, drafted } = useDesk();
	return (
		<Show when={session()} fallback={<Desks />}>
			{(desk) => (
				<Show when={view.entries().length > 0} fallback={<div class="empty">The desk is empty.</div>}>
					<Section
						desk={desk()}
						title="Waiting on you"
						entries={view.mine()}
						note={`${view.mine().filter(drafted).length} of ${view.mine().length} drafted`}
					/>
					<Section desk={desk()} title="Waiting on the agents" entries={view.theirs()} />
					<Section
						desk={desk()}
						title="Resolved"
						entries={ordered(view.entries()).filter((entry) => entry.status === "resolved")}
					/>
				</Show>
			)}
		</Show>
	);
}
