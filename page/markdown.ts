/** Entry Markdown → sanitized HTML: GFM, highlighted code, images/GIFs, video via image syntax, and Mermaid. */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import type { Mermaid } from "mermaid";

const video = /\.(mp4|webm|mov|m4v)$/i;
/** Paths relative to the entry's directory load through `base` (`/files/<entry id>/`); `/attachments/…` and URLs as they are. */
const asset = (url: string, base: string) =>
	/^([a-z]+:|#|\/)/i.test(url) ? url : `${base}${url.replace(/^\.\//, "")}`;

/** A draft's attachment, still in the browser: its object URL and MIME type. */
export type Local = (id: string) => { readonly url: string; readonly type: string } | undefined;

/** `base` is where relative paths load from; `local` resolves a draft's `attachment:<id>` references (otherwise left broken). */
export function render(text: string, base: string, local?: Local): string {
	const template = document.createElement("template");
	// `attachment:` isn't a scheme DOMPurify keeps, but a fragment is; the object URL goes in after sanitizing.
	template.innerHTML = DOMPurify.sanitize(
		marked.parse(text.replaceAll("](attachment:", "](#attachment:"), { async: false }),
	);
	const attached = (url: string) =>
		url.startsWith("#attachment:") ? local?.(url.slice("#attachment:".length)) : undefined;
	for (const img of template.content.querySelectorAll("img")) {
		const file = attached(img.getAttribute("src") ?? "");
		const src = file?.url ?? asset(img.getAttribute("src") ?? "", base);
		if (!(file ? file.type.startsWith("video/") : video.test(src))) {
			img.src = src;
			continue;
		}
		const player = Object.assign(document.createElement("video"), {
			src,
			controls: true,
			loop: true,
			muted: true,
			title: img.alt,
		});
		img.replaceWith(player);
	}
	for (const link of template.content.querySelectorAll("a")) {
		const href = link.getAttribute("href") ?? "";
		link.href = attached(href)?.url ?? asset(href, base);
		link.target = "_blank";
	}
	for (const code of template.content.querySelectorAll("pre > code")) {
		if (!code.classList.contains("language-mermaid")) {
			hljs.highlightElement(code as HTMLElement);
			continue;
		}
		const diagram = Object.assign(document.createElement("div"), {
			className: "mermaid",
			textContent: code.textContent,
		});
		code.parentElement!.replaceWith(diagram);
	}
	return template.innerHTML;
}

/** Mermaid is large: its own chunk, loaded the first time a diagram appears. */
let mermaid: Promise<Mermaid> | undefined;

export async function renderDiagrams(container: HTMLElement): Promise<void> {
	const diagrams = [...container.querySelectorAll<HTMLElement>(".mermaid:not([data-processed])")];
	if (diagrams.length === 0) return;
	mermaid ??= import("mermaid").then(({ default: engine }) => {
		engine.initialize({ startOnLoad: false, securityLevel: "strict" });
		return engine;
	});
	await (await mermaid).run({ nodes: diagrams });
}
