/**
 * The demo: PNG stills of the page and a walk-through GIF, from a sample desk on a temporary store.
 *
 *   bun run demo [out-dir]        # default: docs/demo
 *
 * The service runs in this process with a fake OpenCode (`tests/support/fake-opencode.ts`); the sample questions
 * are asked over the socket the way the plugin asks them. Nothing touches the real store. Needs Google Chrome
 * (driven headless through playwright-core) and ffmpeg.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { fakeOpenCode } from "../tests/support/fake-opencode";
import { eventually, startService } from "../tests/support/service";

const out = resolve(process.argv[2] ?? join(import.meta.dir, "../docs/demo"));

function ffmpeg(...args: Array<string>) {
	const result = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...args], { stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** Waits for the first view, images and Mermaid diagrams. */
async function settle(page: Page) {
	await page.waitForSelector("header");
	await page.waitForFunction(() => [...document.images].every((image) => image.complete) && [...document.querySelectorAll(".mermaid")].every((diagram) => diagram.querySelector("svg")));
	await page.waitForTimeout(300);
}

const temp = await mkdtemp(join(tmpdir(), "desk-demo-"));
const phantom = join(temp, "phantom");
const deskDir = join(temp, "desk");
const store = join(temp, "store");
await mkdir(join(phantom, "design"), { recursive: true });
await mkdir(deskDir, { recursive: true });
await mkdir(store, { recursive: true });
await writeFile(
	join(phantom, "design", "empty.svg"),
	`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140" viewBox="0 0 360 140"><rect width="360" height="140" rx="12" fill="#eef1f5"/><g fill="none" stroke="#6b7280" stroke-width="4" stroke-linecap="round"><path d="M40 90 l30 -40 l30 40 z"/><circle cx="160" cy="70" r="28"/><rect x="230" y="42" width="56" height="56" rx="8"/></g><text x="180" y="128" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#6b7280">A · B · C</text></svg>`,
);
// The project cache, as a service that ran before would have left it: the page sorts entries while no OpenCode is up.
await writeFile(join(store, "projects.json"), JSON.stringify({ sessions: { ses_main: "prj_phantom", ses_review: "prj_phantom", ses_desk: "prj_desk" }, directories: { prj_phantom: phantom, prj_desk: deskDir } }));

const fake = fakeOpenCode();
const opencode = fake.server("http://127.0.0.1:4096");
for (const [id, projectID, directory] of [["ses_main", "prj_phantom", phantom], ["ses_review", "prj_phantom", phantom], ["ses_desk", "prj_desk", deskDir]] as const) opencode.session({ id, projectID, directory });
const service = await startService({ store, fake });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	await rm(out, { recursive: true, force: true });
	await mkdir(join(out, ".frames"), { recursive: true });

	// A plugin instance whose OpenCode isn't reachable yet: what the user answers waits in the outbox.
	const agent = service.plugin(undefined, { id: "prj_phantom", directory: phantom });
	const ask = (session: string, question: { title: string; body: string; labels?: Array<string>; parent?: string; priority?: "critical" | "high" | "normal" | "low" }) =>
		agent.request("ask", { asker: { session, directory: session === "ses_desk" ? deskDir : phantom }, question });
	const review = await ask("ses_review", { title: "Review PR #84: virtualise the torrent list", body: "The list now renders only visible rows. Questions below; screenshots in the PR.", labels: ["pr:84", "review"], priority: "high" });
	const rows = await ask("ses_review", { title: "Keep the row height fixed at 28 px?", body: "Variable heights would need measuring every row. **Recommendation:** fixed, 28 px.", labels: ["pr:84"] });
	await ask("ses_review", { title: "Which empty-state icon?", body: "For an empty list:\n\n![options](design/empty.svg)\n\nI'd take **B** (the circle): it reads as \"nothing here\" without looking like an error.", labels: ["pr:84", "design"] });
	await ask("ses_main", {
		title: "How should the daemon restart after an update?",
		body: "Proposed handshake:\n\n```mermaid\nsequenceDiagram\n  participant GUI\n  participant Daemon\n  GUI->>Daemon: update ready\n  Daemon->>Daemon: finish pending writes\n  Daemon-->>GUI: restarting\n  Daemon->>Daemon: exec new binary\n  GUI->>Daemon: reconnect\n```\n\nThe GUI shows *Restarting…* in the toolbar meanwhile.",
		labels: ["architecture"],
	});
	await ask("ses_main", { title: "The disk is full: may I delete ~/Downloads/.phantom-cache (12 GB)?", body: "Tests can't write their temp files. The cache holds only partial pieces of finished torrents.", priority: "critical" });
	await ask("ses_main", { title: "Rename \"Destination\" to \"Folder\" in the add dialog?", body: "Shorter, but the glossary says *destination*.", labels: ["glossary"], priority: "low" });
	await ask("ses_desk", { title: "Default port for the desk page?", body: "47400 is free here; Phantom's old desk uses 47309." });
	console.log(`sample desk at ${service.url}`);
	const page = (project?: string, entry?: string) => `${service.url}${project ? `?project=${project}` : ""}${entry ? `#/${entry}` : ""}`;

	const stills: Array<[name: string, url: string, scheme: "light" | "dark"]> = [
		["desk-projects", page(), "light"],
		["desk-list", page("prj_phantom"), "light"],
		["desk-entry-mermaid", "mermaid", "light"],
		["desk-entry-image", "image", "light"],
		["desk-review-dark", page("prj_phantom", review.id), "dark"],
	];
	for (const [name, target, scheme] of stills) {
		const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
		const tab = await context.newPage();
		if (target === "mermaid" || target === "image") {
			await tab.goto(page("prj_phantom"));
			await settle(tab);
			await tab.click(`.list a:has-text("${target === "mermaid" ? "daemon restart" : "empty-state icon"}")`);
		} else await tab.goto(target);
		await settle(tab);
		await tab.screenshot({ path: join(out, `${name}.png`), fullPage: true });
		await context.close();
		console.log(`wrote ${name}.png`);
	}

	// The walk: answer from the list, the answer waits for its OpenCode, which connects, and it goes out.
	const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme: "light" });
	const tab = await context.newPage();
	let frame = 0;
	const snap = async (count = 1) => {
		for (let i = 0; i < count; i++) await tab.screenshot({ path: join(out, ".frames", `frame_${String(frame++).padStart(4, "0")}.png`) });
	};
	await tab.goto(page("prj_phantom"));
	await settle(tab);
	await snap(16);
	await tab.click(`.list a[href="#/${rows.id}"]`);
	await settle(tab);
	await snap(10);
	await tab.click("textarea");
	for (const char of "Fixed, 28 px. Ship it.") {
		await tab.keyboard.type(char);
		await snap();
	}
	await snap(6);
	await tab.click("text=Send now");
	await tab.waitForSelector(".pill.undelivered");
	await snap(18);
	await tab.click("text=← All entries");
	await settle(tab);
	await snap(16);
	service.plugin(opencode.endpoint, { id: "prj_phantom", directory: phantom }); // that OpenCode connects
	await eventually(() => opencode.admitted.length === 1);
	await tab.waitForSelector(".pill.undelivered", { state: "detached" });
	await snap(20);
	await context.close();

	ffmpeg("-framerate", "10", "-i", join(out, ".frames", "frame_%04d.png"), "-vf", "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", join(out, "desk-walk.gif"));
	await rm(join(out, ".frames"), { recursive: true, force: true });
	console.log(`wrote desk-walk.gif\ndelivered to ${opencode.admitted[0]!.sessionID} as ${opencode.admitted[0]!.id}:\n${opencode.admitted[0]!.text.split("\n\n").slice(0, 3).join("\n\n")}\n\nDemo in ${out}`);
} finally {
	await browser.close();
	await service.close();
	await rm(temp, { recursive: true, force: true });
}
