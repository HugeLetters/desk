/** @jsxImportSource solid-js */
/** Small inline icons (Lucide-style strokes), so buttons need no icon font. */
const icons = {
	attach: "m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
	send: "m22 2-7 20-4-9-9-4Zm0 0L11 13",
	now: "M13 2 3 14h9l-1 8 10-12h-9Z",
	next: "M5 12h14m-7-7 7 7-7 7",
	done: "M20 6 9 17l-5-5",
	copy: "M8 8h12v12H8ZM4 16V4h12",
};

export const Icon = (props: { name: keyof typeof icons }) => (
	<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
		<path d={icons[props.name]} />
	</svg>
);
