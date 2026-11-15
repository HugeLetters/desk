/** @jsxImportSource solid-js */
import { Show } from "solid-js";
import { type Entry, openUnder } from "../../src/model/entry";
import { useDesk, yours } from "../desk";

/** A desk whose session no connected OpenCode knows: it may be gone, and another session can claim its desk. */
export const Unknown = (props: { session: string }) => (
	<span
		class="label"
		title={`No connected OpenCode knows session ${props.session}: it may be gone. Answers to it wait until one does; another session can take this desk over (desk_claim ${props.session}).`}
	>
		unknown session
	</span>
);

/** An entry's status, whether its text is delivered, whose turn it is, and (on a review) how much is open below it. */
export const Pills = (props: { entry: Entry }) => {
	const desk = useDesk();
	return (
		<>
			<span class={`pill ${desk.drafted(props.entry) ? "drafted" : props.entry.status}`}>
				{desk.drafted(props.entry) ? "drafted" : props.entry.status}
			</span>
			<Show when={props.entry.pending !== null}>
				<span
					class={`pill undelivered${desk.view.failure(props.entry) ? " failed" : ""}`}
					title={desk.view.undelivered(props.entry)}
				>
					{desk.view.outOfDeskMode(props.entry) ? "waiting for desk mode" : "not delivered"}
				</span>
			</Show>
			<Show when={yours(props.entry)}>
				<span class="pill yours">your turn</span>
			</Show>
			<Show when={props.entry.labels.includes("review") && openUnder(desk.view.entries(), props.entry).length}>
				{(count) => (
					<span class="below" title="Entries below this one that aren't resolved yet">
						{count()} open below
					</span>
				)}
			</Show>
		</>
	);
};

/** An entry's priority, when it's above normal. */
export const Priority = (props: { entry: Entry }) => (
	<>
		<Show when={props.entry.priority === "critical"}>
			<span class="crit" title="Critical: blocking work right now">
				▲▲
			</span>
		</Show>
		<Show when={props.entry.priority === "high"}>
			<span class="high" title="High priority">
				▲
			</span>
		</Show>
	</>
);
