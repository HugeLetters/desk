/**
 * The service through its public seams: plugin instances on the socket, the page's RPC and HTTP, the store's files,
 * and fake OpenCode servers on the other side.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type EntryId, parse } from "../src/entry";
import type { View } from "../src/page-api";
import { folder } from "../src/projects";
import { Outdated, protocol } from "../src/protocol";
import { Refusal } from "../src/errors";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as App from "../src/service/app";
import { changedSinceStart } from "../src/service/socket";
import { expectBuiltPage } from "./support/page";
import { eventually, type Service, startService } from "./support/service";
import { E, S, P } from "./support/ids";

let service: Service;
beforeEach(async () => {
	service = await startService();
});
afterEach(() => service.close());

const entryFiles = async () => (await readdir(service.store)).filter((name) => name.endsWith(".md")).sort();
const read = async (id: string) => parse(id as EntryId, await readFile(join(service.store, `${id}.md`), "utf8")).pipe((option) => (option._tag === "Some" ? option.value : undefined))!;
const question = (title: string, extra: { parent?: EntryId; labels?: Array<string> } = {}) => ({ title, body: `About ${title}.`, ...extra });
/** The latest view of `project` (waits for the first). */
const view = (project?: string) => service.rpc((client) => client.view({ project }).pipe(Stream.take(1), Stream.runCollect)).then((views) => Array.from(views)[0]!);

describe("entries", () => {
	test("an agent's question is a file in the flat store, with its root session and directory", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/work/phantom" }, question: question("Which icon?") });
		expect(await entryFiles()).toEqual([`${asked.id}.md`]);
		expect(await read(asked.id)).toMatchObject({ session: S("ses_a"), directory: "/work/phantom", asker: "agent", status: "open", title: "Which icon?", pending: null });
		expect(asked.url).toBe(`${service.url}projects/${encodeURIComponent(folder("/work/phantom"))}/questions/${asked.id}`);
	});

	test("the service reads the store again on restart, and takes in edits made by others", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Kept?") });
		await service.close(false);
		service = await startService({ store: service.store });
		expect(await service.plugin().request("list", { session: S("ses_a") })).toContain(`${asked.id} Kept?`);
		const text = await readFile(join(service.store, `${asked.id}.md`), "utf8");
		await writeFile(join(service.store, `${asked.id}.md`), text.replace("# Kept?", "# Edited by hand"));
		await eventually(async () => (await service.plugin().request("list", { session: S("ses_a") })).includes("Edited by hand"));
	});

	test("the rules: answerer answers, asker resolves, nothing resolves over open follow-ups, resolved leaves leave", async () => {
		const plugin = service.plugin();
		const asker = { session: S("ses_a"), directory: "/w" };
		const root = await plugin.request("ask", { asker, question: question("Root") });
		const child = await plugin.request("ask", { asker, question: question("Child", { parent: root.id }) });
		expect(child.parent).toBe(root.id);
		await expect(plugin.request("answer", { id: root.id, body: "x" })).rejects.toThrow("the user answers it");
		await expect(plugin.request("resolve", { id: root.id })).rejects.toThrow(`1 open below it, so it can't be resolved yet: ${child.id}`);
		// An id that isn't one doesn't even leave (the contract is checked on both sides); a well-formed one the desk doesn't have is refused by the desk.
		await expect(plugin.request("ask", { asker, question: question("Orphan", { parent: E("missing") }) })).rejects.toThrow("Schema validation failed");
		const missing = E(crypto.randomUUID());
		await expect(plugin.request("ask", { asker, question: question("Orphan", { parent: missing }) })).rejects.toThrow(`No desk entry ${missing}`);
		await plugin.request("resolve", { id: child.id });
		await plugin.request("resolve", { id: root.id });
		expect(await entryFiles()).toEqual([]);
	});

	test("a PR's question goes under that project's review entry", async () => {
		const plugin = service.plugin();
		const asker = { session: S("ses_a"), directory: "/w" };
		const review = await plugin.request("ask", { asker, question: question("Review PR #7", { labels: ["pr:7", "review"] }) });
		const q = await plugin.request("ask", { asker, question: question("Q", { labels: ["pr:7"] }) });
		expect(q.parent).toBe(review.id);
		expect(review.parent).toBeNull();
	});
});

describe("delivery", () => {
	test("a refused delivery shows why on the page, doesn't hold up other sessions, and clears once it goes out", async () => {
		const refusing = service.fake.server("http://opencode-1");
		const fine = service.fake.server("http://opencode-2");
		refusing.session({ id: S("ses_a") });
		fine.session({ id: S("ses_b") });
		refusing.refuse = "Session is archived";
		const plugin = service.plugin(refusing);
		service.plugin(fine);
		const a = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("A?") });
		const b = await plugin.request("ask", { asker: { session: S("ses_b"), directory: "/w" }, question: question("B?") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: a.id, text: "yes" }, { entry: b.id, text: "no" }] }));
		await eventually(() => fine.admitted.length === 1);
		const message = (await read(a.id))!.pending!.message;
		await eventually(async () => (await view()).failures[message]?.cause.includes("Session is archived"));
		refusing.refuse = undefined;
		await eventually(() => refusing.admitted.length === 1);
		await eventually(async () => Object.keys((await view()).failures).length === 0);
	});

	test("the user's answer reaches its session once, as one message per session, and leaves the outbox", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a"), projectID: P("prj_phantom"), directory: "/work/phantom" });
		server.session({ id: S("ses_b"), projectID: P("prj_phantom"), directory: "/work/phantom" });
		const plugin = service.plugin(server);
		const a = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/work/phantom" }, question: question("A?") });
		const a2 = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/work/phantom" }, question: question("A2?") });
		const b = await plugin.request("ask", { asker: { session: S("ses_b"), directory: "/work/phantom" }, question: question("B?") });
		const sent = await service.rpc((client) => client.submit({ drafts: [{ entry: a.id, text: "yes" }, { entry: a2.id, text: "also" }, { entry: b.id, text: "no" }] }));
		expect(sent).toBe(3);
		await eventually(() => server.admitted.length === 2);
		const [toA, toB] = [server.admitted.find((p) => p.sessionID === "ses_a")!, server.admitted.find((p) => p.sessionID === "ses_b")!];
		expect(toA.text).toContain(`## ${a.id} Answered: A?\n\nyes`);
		// Where to reply is said with it: on the desk, under the entry.
		expect(toA.text).toContain("Reply there too: a follow-up under the entry (desk_ask with its id as parent)");
		expect(toA.text).toContain(`## ${a2.id} Answered: A2?\n\nalso`);
		expect(toA.id).toStartWith("msg_");
		expect(toA.delivery).toBe("queue");
		expect(toB.text).toContain("no");
		await eventually(async () => (await read(a.id))?.pending === null);
		expect(await read(a.id)).toMatchObject({ status: "answered", answer: "yes", pending: null });
		await Bun.sleep(200);
		expect(server.calls).toHaveLength(2);
	});

	test("the user can discard a delivery that can't happen (its session is gone): the text stays, the entry can be resolved, nothing goes out later", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: S("ses_gone"), directory: "/w" }, question: question("Gone?") });
		await service.rpc((client) => client.send({ entry: asked.id, text: "Too late" }));
		await expect(plugin.request("resolve", { id: asked.id })).rejects.toThrow("hasn't reached the session yet");
		await service.rpc((client) => client.discard({ entry: asked.id }));
		expect(await read(asked.id)).toMatchObject({ status: "answered", answer: "Too late", pending: null });
		await expect(service.rpc((client) => client.discard({ entry: asked.id }))).rejects.toMatchObject({ _tag: "NothingUndelivered", id: asked.id });
		const server = service.fake.server("http://opencode-late");
		server.session({ id: S("ses_gone") });
		service.plugin(server);
		await Bun.sleep(300);
		expect(server.calls).toHaveLength(0);
		await plugin.request("resolve", { id: asked.id });
	});

	test("with no OpenCode that knows the session, it stays answered, not delivered, and goes out once one connects", async () => {
		const plugin = service.plugin();
		const asked = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Later?") });
		await service.rpc((client) => client.send({ entry: asked.id, text: "now" }));
		await Bun.sleep(200);
		const pending = await read(asked.id);
		expect(pending).toMatchObject({ status: "answered", pending: { delivery: "steer" } });
		expect(pending?.pending?.message).toStartWith("msg_");
		expect((await view(folder("/w"))).entries[0]!.pending).toEqual(pending!.pending);
		await expect(plugin.request("resolve", { id: asked.id })).rejects.toThrow("hasn't reached the session yet");

		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a") });
		service.plugin(server);
		await eventually(() => server.admitted.length === 1);
		expect(server.admitted[0]).toMatchObject({ sessionID: S("ses_a"), id: pending!.pending!.message, delivery: "steer" });
		await eventually(async () => (await read(asked.id))?.pending === null);
	});

	test("a lost reply is retried under the same message id, so the session gets it once", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a") });
		server.loseNextReply = true;
		const plugin = service.plugin(server);
		const asked = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Once?") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "once" }] }));
		await eventually(async () => (await read(asked.id))?.pending === null);
		expect(server.calls.length).toBeGreaterThanOrEqual(2);
		expect(new Set(server.calls.map((call) => call.id)).size).toBe(1);
		expect(server.admitted).toHaveLength(1);
	});

	test("an undelivered message survives a restart of the service", async () => {
		const asked = await service.plugin().request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Restart?") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "kept" }] }));
		const message = await eventually(async () => (await read(asked.id))?.pending?.message);
		await service.close(false);
		service = await startService({ store: service.store });
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a") });
		service.plugin(server);
		await eventually(() => server.admitted.length === 1);
		expect(server.admitted[0]!.id).toBe(message);
	});

	test("the user's reply on an entry not waiting for an answer is a follow-up in the same session", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a") });
		const plugin = service.plugin(server);
		const asked = await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Agents'") });
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "Answer." }] }));
		await service.rpc((client) => client.submit({ drafts: [{ entry: asked.id, text: "A question back?\n\nDetails." }] }));
		await eventually(() => server.admitted.length === 2);
		const followUp = (await view("prj_default")).entries.find((entry) => entry.asker === "user")!;
		expect(followUp).toMatchObject({ parent: asked.id, session: S("ses_a"), directory: "/w", title: "A question back?" });
		expect(server.admitted[1]!.text).toContain(`## ${followUp.id} New question from the user (follow-up to ${asked.id})`);
		await plugin.request("answer", { id: followUp.id, body: "Here." });
		await eventually(async () => (await read(followUp.id))?.pending === null);
		await service.rpc((client) => client.resolve({ id: followUp.id }));
		expect(await entryFiles()).toEqual([`${asked.id}.md`]);
	});

	test("attachments: stored under the store, linked as /attachments/…, passed to the session, served to the page", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_a") });
		const asked = await service.plugin(server).request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Picture?") });
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
		server.session({ id: S("ses_p"), projectID: P("prj_phantom") });
		server.session({ id: S("ses_q"), projectID: P("prj_other") });
		const plugin = service.plugin(server, { id: P("prj_phantom"), directory: "/work/phantom" });
		service.plugin(server, { id: P("prj_other"), directory: "/work/other" });
		const p = await plugin.request("ask", { asker: { session: S("ses_p"), directory: "/work/phantom" }, question: question("P?") });
		await plugin.request("ask", { asker: { session: S("ses_q"), directory: "/work/other" }, question: question("Q?") });
		expect(p.url).toBe(`${service.url}projects/prj_phantom/questions/${p.id}`);
		const phantom = await view("prj_phantom");
		expect(phantom.project).toEqual({ id: P("prj_phantom"), name: "phantom", guessed: false });
		expect(phantom.entries.map((entry) => entry.title)).toEqual(["P?"]);
		expect(phantom.projects.map((project) => [project.name, project.waiting])).toEqual([
			["other", 1],
			["phantom", 1],
		]);
		expect(await plugin.request("list", { session: S("ses_p") })).not.toContain("Q?");

		server.move(S("ses_q"), P("prj_phantom"));
		await eventually(async () => (await view("prj_phantom")).entries.length === 2);
	});

	test("an entry no connected OpenCode knows goes under its folder until one that knows it connects", async () => {
		await service.plugin().request("ask", { asker: { session: S("ses_p"), directory: "/work/phantom/app" }, question: question("Where?") });
		expect((await view()).projects.map((project) => [project.id, project.name, project.guessed])).toEqual([[folder("/work/phantom/app"), "app", true]]);
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_p"), projectID: P("prj_phantom") });
		service.plugin(server, { id: P("prj_phantom"), directory: "/work/phantom" });
		await eventually(async () => (await view()).projects[0]?.id === "prj_phantom");
		expect((await view()).opencode).toBe(2);
	});

	test("a known project stays while OpenCode is away; the next connect catches a move missed meanwhile", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_p"), projectID: P("prj_phantom") });
		const first = service.plugin(server, { id: P("prj_phantom"), directory: "/work/phantom" });
		await first.request("ask", { asker: { session: S("ses_p"), directory: "/work/phantom" }, question: question("Where?") });
		expect((await view()).opencode).toBe(1);

		await first.close();
		server.sessions.set(S("ses_p"), { ...server.sessions.get(S("ses_p"))!, projectID: P("prj_moved") }); // moved, nobody told
		await eventually(async () => (await view()).opencode === 0);
		expect((await view()).projects.map((project) => [project.id, project.guessed])).toEqual([["prj_phantom", false]]);

		service.plugin(server);
		await eventually(async () => (await view()).projects[0]?.id === "prj_moved");
		expect((await view()).opencode).toBe(1);
	});

	test("a project no plugin instance has reported is named after its session's folder, not its id", async () => {
		const server = service.fake.server("http://opencode-1");
		server.session({ id: S("ses_p"), projectID: P("prj_phantom"), directory: "/work/phantom" });
		// This plugin instance's own location is another project: nobody reports prj_phantom's directory.
		const plugin = service.plugin(server, { id: P("prj_other"), directory: "/work/other" });
		const { url } = await plugin.request("page", { session: S("ses_p") });
		expect(url).toBe(`${service.url}projects/prj_phantom`);
		expect((await view("prj_phantom")).project).toEqual({ id: P("prj_phantom"), name: "phantom", guessed: false });
	});

	test("without a project, the page lists the projects only", async () => {
		await service.plugin().request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Somewhere?") });
		const all = await view();
		expect(all.project).toBeNull();
		expect(all.entries).toEqual([]);
		expect(all.projects).toEqual([{ id: folder("/w"), name: "w", guessed: true, waiting: 1, critical: 0 }]);
	});

	test("a live view follows changes", async () => {
		const plugin = service.plugin();
		await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("First") });
		const views = service.rpc((client) => client.view({ project: folder("/w") }).pipe(Stream.take(2), Stream.runCollect));
		await Bun.sleep(200);
		await plugin.request("ask", { asker: { session: S("ses_a"), directory: "/w" }, question: question("Second") });
		expect(Array.from(await views).map((one: View) => one.entries.length)).toEqual([1, 2]);
	});
});

describe("the page server", () => {
	test("serves the page as built by Vite", async () => {
		await expectBuiltPage(service.url.replace(/\/$/, ""));
	});

	test("a link to a project or an entry opens the page, its assets from the root", async () => {
		const shell = await (await fetch(service.url)).text();
		for (const path of ["projects/prj_phantom", "projects/prj_phantom/questions/0190abcd"]) {
			const response = await fetch(`${service.url}${path}`, { headers: { accept: "text/html" } });
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(shell);
		}
		expect(shell).toMatch(/src="\/assets\//);
	});

	test("serves files relative to an entry's directory, nothing outside it", async () => {
		const directory = join(service.store, "work");
		await mkdir(join(directory, "media"), { recursive: true });
		await writeFile(join(directory, "media", "a.txt"), "inside");
		const asked = await service.plugin().request("ask", { asker: { session: S("ses_a"), directory }, question: question("Media") });
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
	/** Builds another service on `store` (the socket in it), on `port`; closes it again unless kept. */
	const another = async (store: string, port: number) => {
		const scope = Effect.runSync(Scope.make());
		const exit = await Effect.runPromiseExit(Layer.buildWithScope(App.layer({ store, socket: join(store, "desk.sock"), port, idle: 60_000 }), scope));
		return { exit, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
	};

	test("one per store: the running service is registered in service.json, and a second one, on any port, refuses to start", async () => {
		const registered = JSON.parse(await readFile(join(service.store, "service.json"), "utf8"));
		expect(registered).toEqual({ pid: process.pid, protocol, url: service.url, socket: service.socket });
		const second = await another(service.store, 0);
		await second.close();
		expect(Exit.isFailure(second.exit) && String(second.exit.cause)).toContain("AlreadyRunning");
		// It left the first one's registration alone.
		expect(JSON.parse(await readFile(join(service.store, "service.json"), "utf8")).url).toBe(service.url);
	});

	test("a registration whose process is gone is stale and replaced; a stopped service removes its own", async () => {
		const store = await mkdtemp(join(tmpdir(), "desk-"));
		await writeFile(join(store, "service.json"), JSON.stringify({ pid: 2 ** 22 + 12345, protocol }));
		const started = await another(store, 0);
		expect(Exit.isSuccess(started.exit)).toBe(true);
		expect(JSON.parse(await readFile(join(store, "service.json"), "utf8")).pid).toBe(process.pid);
		await started.close();
		expect(existsSync(join(store, "service.json"))).toBe(false);
		await rm(store, { recursive: true, force: true });
	});

	test("the page takes its port when it's free, and any free port when it isn't", async () => {
		const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("someone else") });
		const store = await mkdtemp(join(tmpdir(), "desk-"));
		const started = await another(store, taken.port!);
		const url = JSON.parse(await readFile(join(store, "service.json"), "utf8")).url as string;
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(url).not.toContain(`:${taken.port}/`);
		await started.close();
		taken.stop(true);
		await rm(store, { recursive: true, force: true });
	});

	test("the protocol version is generated: a revision and a hash of the contract's schemas", () => {
		expect(protocol).toMatch(/^\d+\.[0-9a-z]+$/);
	});

	test("the service is outdated once its contract files change after it started", async () => {
		expect(changedSinceStart(Date.now() + 60_000)()).toBe(false);
		expect(changedSinceStart(0)()).toBe(true);
	});

	test("requests are checked against the protocol: a malformed one is refused, and writes nothing", async () => {
		await expect(loose(service.socket, (client) => client.ask({ asker: { session: S("ses_a") }, question: { title: "No body" } }))).rejects.toThrow();
		await expect(loose(service.socket, (client) => client.prioritize({ id: E("x"), priority: "urgent", subtree: false }))).rejects.toThrow();
		expect(await entryFiles()).toEqual([]);
	});

	test("a plugin speaking another protocol: told it's the outdated side while the service is current; once the contract changed on disk, the service is, and retires", async () => {
		await service.close();
		let changed = false;
		service = await startService({ outdated: () => changed });
		expect(await loose(service.socket, (client) => client.hello({ protocol }))).toEqual({ url: service.url });
		await expect(loose(service.socket, (client) => client.hello({ protocol: "2.old" }))).rejects.toMatchObject({ _tag: "Outdated", side: "plugin" });
		changed = true;
		await expect(loose(service.socket, (client) => client.hello({ protocol: "5.new" }))).rejects.toMatchObject({ _tag: "Outdated", side: "service" });
		const { Clients } = await import("../src/service/clients");
		await Effect.runPromise(Effect.provideContext(Clients.use((clients) => clients.idle), service.services as never).pipe(Effect.timeout("2 seconds")));
	});

	test("plugin instances and open pages are its clients; it's idle once the last one has been gone a while", async () => {
		await service.close();
		service = await startService({ idle: 150 });
		const plugin = service.plugin();
		await plugin.url();
		await eventually(async () => (await service.clients()) === 1);
		const page = service.rpc((client) => client.view({}).pipe(Stream.take(1), Stream.runDrain));
		await page;
		await plugin.close();
		await eventually(async () => (await service.clients()) === 0);
		const { Clients } = await import("../src/service/clients");
		await Effect.runPromise(Effect.provideContext(Clients.use((clients) => clients.idle), service.services as never).pipe(Effect.timeout("2 seconds")));
	});
});

/**
 * The plugin's contract with every payload let through unchecked, for what the plugin itself never sends: the service
 * checks it all the same.
 */
const Loose = RpcGroup.make(
	Rpc.make("hello", { payload: Schema.Unknown, success: Schema.Struct({ url: Schema.String }), error: Outdated }),
	Rpc.make("ask", { payload: Schema.Unknown, success: Schema.Unknown, error: Refusal }),
	Rpc.make("prioritize", { payload: Schema.Unknown, error: Refusal }),
);
const loose = <A, E>(path: string, f: (client: RpcClient.FromGroup<typeof Loose, RpcClientError>) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.flatMap(RpcClient.make(Loose), f).pipe(
			Effect.scoped,
			Effect.provide(RpcClient.layerProtocolSocket().pipe(Layer.provide(BunSocket.layerNet({ path })), Layer.provide(RpcSerialization.layerNdjson))),
		),
	);
