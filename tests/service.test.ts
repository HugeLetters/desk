/**
 * The service through its public seams: plugin instances on the socket, the page's RPC and HTTP, the store's files,
 * and fake OpenCode servers on the other side.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { parse } from "../src/entry";
import { unknownProject, type View } from "../src/page-api";
import * as App from "../src/service/app";
import { fakeOpenCode } from "./support/fake-opencode";
import { expectBuiltPage } from "./support/page";
import { eventually, type Service, startService } from "./support/service";

let service: Service;
beforeEach(async () => {
	service = await startService();
});
afterEach(() => service.close());

const entryFiles = async () => (await readdir(service.store)).filter((name) => name.endsWith(".md")).sort();
const read = async (id: string) => parse(id, await readFile(join(service.store, `${id}.md`), "utf8")).pipe((option) => (option._tag === "Some" ? option.value : undefined))!;
const question = (title: string, extra: { parent?: string; labels?: Array<string> } = {}) => ({ title, body: `About ${title}.`, ...extra });
/** The latest view of `project` (waits for the first). */
const view = (project?: string) => service.rpc((client) => client.view({ project }).pipe(Stream.take(1), Stream.runCollect)).then((views) => Array.from(views)[0]!);

describe("entries", () => {
	test("an agent's question is a file in the flat store, with its root session and directory", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: "ses_a", directory: "/work/phantom" }, question: question("Which icon?") });
		expect(await entryFiles()).toEqual([`${asked.id}.md`]);
		expect(await read(asked.id)).toMatchObject({ session: "ses_a", directory: "/work/phantom", asker: "agent", status: "open", title: "Which icon?", outbox: null });
		expect(asked.url).toBe(`${service.url}?project=${unknownProject}#/${asked.id}`);
	});

	test("the service reads the store again on restart, and takes in edits made by others", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Kept?") });
		await service.close(false);
		service = await startService({ store: service.store });
		expect(await service.plugin().request("list", { session: "ses_a" })).toContain(`${asked.id} Kept?`);
		const text = await readFile(join(service.store, `${asked.id}.md`), "utf8");
		await writeFile(join(service.store, `${asked.id}.md`), text.replace("# Kept?", "# Edited by hand"));
		await eventually(async () => (await service.plugin().request("list", { session: "ses_a" })).includes("Edited by hand"));
	});

	test("the rules: answerer answers, asker resolves, nothing resolves over open follow-ups, resolved leaves leave", async () => {
		const plugin = service.plugin();
		const asker = { session: "ses_a", directory: "/w" };
		const root = await plugin.request("ask", { asker, question: question("Root") });
		const child = await plugin.request("ask", { asker, question: question("Child", { parent: root.id }) });
		expect(child.parent).toBe(root.id);
		await expect(plugin.request("answer", { id: root.id, body: "x" })).rejects.toThrow("the user answers it");
		await expect(plugin.request("resolve", { id: root.id })).rejects.toThrow(`1 open below it, so it can't be resolved yet: ${child.id}`);
		await expect(plugin.request("ask", { asker, question: question("Orphan", { parent: "missing" }) })).rejects.toThrow("No desk entry missing");
		await plugin.request("resolve", { id: child.id });
		await plugin.request("resolve", { id: root.id });
		expect(await entryFiles()).toEqual([]);
	});

	test("a PR's question goes under that project's review entry", async () => {
		const plugin = service.plugin();
		const asker = { session: "ses_a", directory: "/w" };
		const review = await plugin.request("ask", { asker, question: question("Review PR #7", { labels: ["pr:7", "review"] }) });
		const q = await plugin.request("ask", { asker, question: question("Q", { labels: ["pr:7"] }) });
		expect(q.parent).toBe(review.id);
		expect(review.parent).toBeNull();
	});
});

describe("delivery", () => {
	test("the user's answer reaches its session once, as one message per session, and leaves the outbox", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a", projectID: "prj_phantom", directory: "/work/phantom" });
		server.session({ id: "ses_b", projectID: "prj_phantom", directory: "/work/phantom" });
		const plugin = service.plugin(server.endpoint);
		const a = await plugin.request("ask", { asker: { session: "ses_a", directory: "/work/phantom" }, question: question("A?") });
		const a2 = await plugin.request("ask", { asker: { session: "ses_a", directory: "/work/phantom" }, question: question("A2?") });
		const b = await plugin.request("ask", { asker: { session: "ses_b", directory: "/work/phantom" }, question: question("B?") });
		const sent = await service.rpc((client) => client.submit({ drafts: [{ entry: a.id, text: "yes" }, { entry: a2.id, text: "also" }, { entry: b.id, text: "no" }] }));
		expect(sent).toBe(3);
		await eventually(() => server.admitted.length === 2);
		const [toA, toB] = [server.admitted.find((p) => p.sessionID === "ses_a")!, server.admitted.find((p) => p.sessionID === "ses_b")!];
		expect(toA.text).toContain(`## ${a.id} Answered: A?\n\nyes`);
		expect(toA.text).toContain(`## ${a2.id} Answered: A2?\n\nalso`);
		expect(toA.id).toStartWith("msg_");
		expect(toA.delivery).toBe("queue");
		expect(toB.text).toContain("no");
		await eventually(async () => (await read(a.id))?.outbox === null);
		expect(await read(a.id)).toMatchObject({ status: "answered", answer: "yes", outbox: null, delivery: null });
		await Bun.sleep(200);
		expect(server.calls).toHaveLength(2);
	});

	test("with no OpenCode that knows the session, it stays answered, not delivered, and goes out once one connects", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Later?") });
		await service.rpc((client) => client.send({ entry: asked.id, text: "now" }));
		await Bun.sleep(200);
		const pending = await read(asked.id);
		expect(pending).toMatchObject({ status: "answered", delivery: "steer" });
		expect(pending?.outbox).toStartWith("msg_");
		expect((await view(unknownProject)).entries[0]!.outbox).toBe(pending!.outbox);
		await expect(plugin.request("resolve", { id: asked.id })).rejects.toThrow("hasn't reached the session yet");

		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a" });
		service.plugin(server.endpoint);
		await eventually(() => server.admitted.length === 1);
		expect(server.admitted[0]).toMatchObject({ sessionID: "ses_a", id: pending!.outbox!, delivery: "steer" });
		await eventually(async () => (await read(asked.id))?.outbox === null);
	});

	test("a lost reply is retried under the same message id, so the session gets it once", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a" });
		server.loseNextReply = true;
		const plugin = service.plugin(server.endpoint);
		const asked = await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Once?") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "once" }] }));
		await eventually(async () => (await read(asked.id))?.outbox === null);
		expect(server.calls.length).toBeGreaterThanOrEqual(2);
		expect(new Set(server.calls.map((call) => call.id)).size).toBe(1);
		expect(server.admitted).toHaveLength(1);
	});

	test("an undelivered message survives a restart of the service", async () => {
		const asked = await service.plugin().request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Restart?") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "kept" }] }));
		const outbox = await eventually(async () => (await read(asked.id))?.outbox);
		await service.close(false);
		service = await startService({ store: service.store });
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a" });
		service.plugin(server.endpoint);
		await eventually(() => server.admitted.length === 1);
		expect(server.admitted[0]!.id).toBe(outbox);
	});

	test("the user's reply on an entry not waiting for an answer is a follow-up in the same session", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a" });
		const plugin = service.plugin(server.endpoint);
		const asked = await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Agents'") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "Answer." }] }));
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "A question back?\n\nDetails." }] }));
		await eventually(() => server.admitted.length === 2);
		const followUp = (await view("prj_default")).entries.find((entry) => entry.asker === "user")!;
		expect(followUp).toMatchObject({ parent: asked.id, session: "ses_a", directory: "/w", title: "A question back?" });
		expect(server.admitted[1]!.text).toContain(`## ${followUp.id} New question from the user (follow-up to ${asked.id})`);
		await plugin.request("answer", { id: followUp.id, body: "Here." });
		await eventually(async () => (await read(followUp.id))?.outbox === null);
		await service.rpc((client) => client.resolve({ id: followUp.id }));
		expect(await entryFiles()).toEqual([`${asked.id}.md`]);
	});

	test("attachments: stored under the store, linked as /attachments/…, passed to the session, served to the page", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_a" });
		const asked = await service.plugin(server.endpoint).request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Picture?") });
		const local = crypto.randomUUID();
		const data = Buffer.from("PNGDATA").toString("base64");
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: `Here: ![shot](attachment:${local})`, files: [{ id: local, name: "shot.png", data }] }] }));
		await eventually(() => server.admitted.length === 1);
		const answer = (await read(asked.id))!.answer!;
		const file = /\/(attachments\/[0-9a-f-]{36}\.png)/.exec(answer)![1]!;
		expect(server.admitted[0]!.files).toEqual([{ uri: `file://${service.store}/${file}`, name: "shot" }]);
		expect(await (await fetch(`${service.url}${file}`)).text()).toBe("PNGDATA");
	});
});

describe("projects", () => {
	test("the page shows one project's desk; entries follow a session that moves", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: "ses_p", projectID: "prj_phantom" });
		server.session({ id: "ses_q", projectID: "prj_other" });
		const plugin = service.plugin(server.endpoint, { id: "prj_phantom", directory: "/work/phantom" });
		service.plugin(server.endpoint, { id: "prj_other", directory: "/work/other" });
		const p = await plugin.request("ask", { asker: { session: "ses_p", directory: "/work/phantom" }, question: question("P?") });
		await plugin.request("ask", { asker: { session: "ses_q", directory: "/work/other" }, question: question("Q?") });
		expect(p.url).toBe(`${service.url}?project=prj_phantom#/${p.id}`);
		const phantom = await view("prj_phantom");
		expect(phantom.project).toEqual({ id: "prj_phantom", name: "phantom" });
		expect(phantom.entries.map((entry) => entry.title)).toEqual(["P?"]);
		expect(phantom.projects.map((project) => [project.name, project.waiting])).toEqual([
			["other", 1],
			["phantom", 1],
		]);
		expect(await plugin.request("list", { session: "ses_p" })).not.toContain("Q?");

		server.move("ses_q", "prj_phantom");
		await eventually(async () => (await view("prj_phantom")).entries.length === 2);
	});

	test("without a project, the page lists the projects only", async () => {
		await service.plugin().request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Somewhere?") });
		const all = await view();
		expect(all.project).toBeNull();
		expect(all.entries).toEqual([]);
		expect(all.projects).toEqual([{ id: unknownProject, name: "Unknown project", waiting: 1, critical: 0 }]);
	});

	test("a live view follows changes", async () => {
		const plugin = service.plugin();
		await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("First") });
		const views = service.rpc((client) => client.view({ project: unknownProject }).pipe(Stream.take(2), Stream.runCollect));
		await Bun.sleep(200);
		await plugin.request("ask", { asker: { session: "ses_a", directory: "/w" }, question: question("Second") });
		expect(Array.from(await views).map((one: View) => one.entries.length)).toEqual([1, 2]);
	});
});

describe("the page server", () => {
	test("serves the page as built by Vite", async () => {
		await expectBuiltPage(service.url.replace(/\/$/, ""));
	});

	test("serves files relative to an entry's directory, nothing outside it", async () => {
		const directory = join(service.store, "work");
		await mkdir(join(directory, "media"), { recursive: true });
		await writeFile(join(directory, "media", "a.txt"), "inside");
		const asked = await service.plugin().request("ask", { asker: { session: "ses_a", directory }, question: question("Media") });
		expect(await (await fetch(`${service.url}files/${asked.id}/media/a.txt`)).text()).toBe("inside");
		expect((await fetch(`${service.url}files/${asked.id}/..%2F..%2Fetc%2Fhosts`)).status).toBe(403);
		expect((await fetch(`${service.url}files/nope/media/a.txt`)).status).toBe(404);
	});

	test("refuses foreign hosts and cross-site writes", async () => {
		expect((await fetch(service.url, { headers: { host: "evil.example" } })).status).toBe(421);
		expect((await fetch(`${service.url}rpc`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
	});
});

describe("the service's life", () => {
	test("one per machine: a second service on the same socket refuses to start", async () => {
		const scope = Effect.runSync(Scope.make());
		const exit = await Effect.runPromiseExit(
			Layer.buildWithScope(App.layer({ store: service.store, socket: service.socket, port: 0, idle: 1000, connect: fakeOpenCode().connect }), scope),
		);
		await Effect.runPromise(Scope.close(scope, Exit.void));
		expect(Exit.isFailure(exit) && String(exit.cause)).toContain("AlreadyRunning");
	});

	test("plugin instances and open pages are its clients; it's idle once the last one has been gone a while", async () => {
		await service.close();
		service = await startService({ idle: 150 });
		const plugin = service.plugin();
		await plugin.url();
		expect(await service.clients()).toBe(1);
		const page = service.rpc((client) => client.view({}).pipe(Stream.take(1), Stream.runDrain));
		await page;
		plugin.close();
		await eventually(async () => (await service.clients()) === 0);
		const { Clients } = await import("../src/service/clients");
		await Effect.runPromise(Effect.provideContext(Clients.use((clients) => clients.idle), service.services as never).pipe(Effect.timeout("2 seconds")));
	});
});
