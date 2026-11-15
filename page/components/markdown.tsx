/** @jsxImportSource solid-js */
import { createEffect } from "solid-js";
import { type Local, render, renderDiagrams } from "../markdown";

/** An entry's Markdown, its relative paths loading from the entry's directory; `local`: a draft's attachments. */
export function Markdown(props: { text: string; entry: string; local?: Local }) {
	let container: HTMLDivElement | undefined;
	createEffect(() => {
		// Solid sets the ref before effects run.
		if (!container) return;

		container.innerHTML = render(props.text, `/files/${props.entry}/`, props.local);
		void renderDiagrams(container);
	});
	return <div class="md" ref={container} />;
}
