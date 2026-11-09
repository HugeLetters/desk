/**
 * The plugin through its `effect(ctx)`, with a fake plugin context standing in for OpenCode and a real desk service,
 * which the plugin starts itself (detached) on a temporary store.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import plugin from "../src/plugin/index";
import { answering } from "../src/plugin/connection";
import { eventually, rpc } from "./support/service";
import type { EntryId } from "../src/entry";
import { S, P } from "./support/ids";

interface Session {
	id: string;
	parentID?: string;
	projectID: string;
	location: { directory: string };
}

type Event = { type: string; data: { sessionID: string } };
type Run<A = unknown> = Effect.Effect<A, unknown>;

/** The parts of the plugin context the desk uses, recording what the plugin registers and says. */
function fakeContext(home: string, sessions: Array<Session>, options: Record<string, unknown> = {}) {
	const tools = new Map<string, { execute: (input: unknown, context: { sessionID: string }) => Run<{ content: string }> }>();
	const commands = new Map<string, { execute: (input: { sessionID: string }) => Run<void> }>();
	const hooks: Array<(event: { sessionID: string; tools: Record<string, unknown> }) => Run<void>> = [];
	const storage = new Map<string, unknown>();
	const synthetic: Array<{ sessionID: string; text: string; description?: string }> = [];
	const prompts: Array<{ sessionID: string; id: string; text: string }> = [];
	const events = Effect.runSync(Queue.unbounded<Event>());
	const ctx = {
		options: { home, port: 0, ...options },
		location: { directory: "/work/phantom", project: { id: P("prj_phantom"), directory: "/work/phantom" } },
		storage: {
			get: (key: string) => Effect.sync(() => storage.get(key)),
			set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
			remove: (key: string) => Effect.sync(() => void storage.delete(key)),
			scan: ({ prefix }: { prefix: string }) => Effect.sync(() => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) })),
		},
		session: {
			get: ({ sessionID }: { sessionID: string }) =>
				Effect.suspend(() => {
					const session = sessions.find((candidate) => candidate.id === sessionID);
					return session ? Effect.succeed(session) : Effect.fail({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` });
				}),
			synthetic: (input: { sessionID: string; text: string; description?: string }) => Effect.sync(() => void synthetic.push(input)),
			prompt: (input: { sessionID: string; id: string; text: string }) => Effect.sync(() => void prompts.push(input)),
			hook: (_name: "context", callback: (typeof hooks)[number]) => Effect.sync(() => void hooks.push(callback)),
		},
		tool: { transform: (callback: (editor: { add: (tool: { name: string } & Parameters<typeof tools.set>[1]) => void }) => void) => Effect.sync(() => callback({ add: (tool) => tools.set(tool.name, tool) })) },
		command: { transform: (callback: (editor: { add: (command: { name: string } & Parameters<typeof commands.set>[1]) => void }) => void) => Effect.sync(() => callback({ add: (command) => commands.set(command.name, command) })) },
		event: { subscribe: () => Stream.fromQueue(events) },
	};
	return {
		ctx,
		storage,
		synthetic,
		prompts,
		/** Pushes an OpenCode event to the plugin's subscription. */
		emit: (event: Event) => Effect.runSync(Queue.offer(events, event)),
		tools,
		/** The tools a model request in `sessionID` gets, after the plugin's context hook. */
		async visible(sessionID: string) {
			const event = { sessionID, tools: Object.fromEntries([...tools.keys(), "read"].map((name) => [name, {}])) };
			for (const hook of hooks) await Effect.runPromise(hook(event));
			return Object.keys(event.tools).sort();
		},
		command: (name: string, sessionID: string) => Effect.runPromise(commands.get(name)!.execute({ sessionID })),
		tool: (name: string, sessionID: string, input: unknown) => Effect.runPromise(tools.get(name)!.execute(input, { sessionID })),
	};
}

/** Loads the plugin into `context`; the returned function unloads it (closes its scope). */
async function load(context: ReturnType<typeof fakeContext>) {
	const scope = Effect.runSync(Scope.make());
	await Effect.runPromise(Scope.provide(plugin.effect(context.ctx as never), scope));
	return () => Effect.runPromise(Scope.close(scope, Exit.void));
}

const sessions: Array<Session> = [
	{ id: S("ses_main"), projectID: P("prj_phantom"), location: { directory: "/work/phantom" } },
	{ id: S("ses_sub"), parentID: S("ses_main"), projectID: P("prj_phantom"), location: { directory: "/work/phantom" } },
	{ id: S("ses_other"), projectID: P("prj_phantom"), location: { directory: "/work/phantom" } },
];
const desk = ["desk_adopt", "desk_answer", "desk_ask", "desk_list", "desk_prioritize", "desk_resolve"];

let home: string;
let first: ReturnType<typeof fakeContext>;
let cleanups: Array<() => unknown> = [];
const previousIdle = process.env.DESK_IDLE;

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "desk-plugin-"));
	process.env.DESK_IDLE = "300"; // the service the plugin starts exits 300 ms after its last client
	first = fakeContext(home, sessions);
	cleanups.push(await load(first));
});

afterAll(async () => {
	for (const cleanup of cleanups) await cleanup();
	if (previousIdle === undefined) delete process.env.DESK_IDLE;
	else process.env.DESK_IDLE = previousIdle;
	await eventually(async () => (await readFile(join(home, "service.log"), "utf8").catch(() => "")).includes("exiting"), 5000).catch(() => {});
	await rm(home, { recursive: true, force: true });
});

test("off by default: a session sees no desk tools until /desk-mode turns it on, for its subagents too", async () => {
	expect(await first.visible("ses_main")).toEqual(["read"]);
	// With no session in desk mode, the plugin doesn't connect, so nothing has started the service.
	expect(await answering(join(home, "desk.sock"))).toBe(false);
	await first.command("desk-mode", "ses_main");
	expect(first.storage.get("on/ses_main")).toBe(true);
	expect(first.synthetic.at(-1)!.text).toMatch(/Desk mode is on for this session.*http:\/\/127\.0\.0\.1:\d+\/projects\//);
	// What the user sees in the TUI: a synthetic message without a description is hidden.
	expect(first.synthetic.at(-1)!.description).toMatch(/^Desk mode on: http:\/\/127\.0\.0\.1:\d+\/projects\//);
	expect(await first.visible("ses_main")).toEqual([...desk, "read"]);
	expect(await first.visible("ses_sub")).toEqual([...desk, "read"]);
	expect(await first.visible("ses_other")).toEqual(["read"]);
	await expect(first.tool("desk_list", "ses_other", {})).rejects.toThrow("The desk is off for this session");
});

test("the plugin started the service, detached, in its store; a subagent's question belongs to its root session", async () => {
	expect(await answering(join(home, "desk.sock"))).toBe(true);
	const result = await first.tool("desk_ask", "ses_sub", { title: "From a subagent?", body: "Details." });
	const id = /Asked ([0-9a-f-]{36}), top-level\./.exec(result.content)![1]!;
	const text = await readFile(join(home, `${id}.md`), "utf8");
	expect(text).toContain("session: ses_main\n");
	expect(text).toContain('directory: "/work/phantom"\n');
	expect((await first.tool("desk_list", "ses_main", {})).content).toContain(`${id} From a subagent?`);
	expect(await readFile(join(home, "service.log"), "utf8")).toContain(`desk: serving ${home}`);
});

test("the plugin is the service's way into its OpenCode: the user's reply goes out through it, and so do moves", async () => {
	const asked = (await first.tool("desk_ask", "ses_main", { title: "Deliver me?", body: "Details." })).content;
	const id = /Asked ([0-9a-f-]{36})/.exec(asked)![1]! as EntryId;
	const page = JSON.parse(await readFile(join(home, "service.json"), "utf8")).url as string;
	await rpc(page, (desk) => desk.send({ entry: id, text: "Yes, deliver.", files: [] }));
	const prompt = await eventually(() => first.prompts.find((candidate) => candidate.text.includes("Yes, deliver.")));
	expect(prompt.sessionID).toBe("ses_main");
	expect(prompt.id).toMatch(/^msg_/);
	// The plugin looked the session's project up for the service; a move in its OpenCode makes the service ask again.
	const projects = async () => Array.from(await rpc(page, (desk) => desk.view({}).pipe(Stream.take(1), Stream.runCollect)))[0]!.projects.map((project) => project.id);
	expect(await projects()).toEqual(["prj_phantom"]);
	sessions[0]!.projectID = "prj_moved";
	first.emit({ type: "session.moved", data: { sessionID: S("ses_main") } });
	await eventually(async () => (await projects()).includes("prj_moved"));
	sessions[0]!.projectID = "prj_phantom";
	first.emit({ type: "session.moved", data: { sessionID: S("ses_main") } });
});

test("a second plugin instance (another OpenCode) shares the one service and the switch", async () => {
	const second = fakeContext(home, sessions);
	second.storage.set("on/ses_main", true); // OpenCode's plugin storage is shared; here each fake has its own
	cleanups.push(await load(second));
	expect((await second.tool("desk_list", "ses_main", {})).content).toContain("From a subagent?");
	const log = await readFile(join(home, "service.log"), "utf8");
	expect(log.match(/desk: serving/g)).toHaveLength(1);
	// The page counts sessions in desk mode, not plugin instances: both report ses_main, which counts once.
	const page = JSON.parse(await readFile(join(home, "service.json"), "utf8")).url as string;
	const view = await rpc(page, (desk) => desk.view({}).pipe(Stream.take(1), Stream.runCollect));
	expect(Array.from(view)[0]!).toMatchObject({ opencode: 2, deskMode: ["ses_main"] });
});

test("/desk-mode again turns it off", async () => {
	await first.command("desk-mode", "ses_sub");
	expect(first.storage.has("on/ses_main")).toBe(false);
	expect(first.synthetic.at(-1)!.text).toContain("Desk mode is off");
	expect(first.synthetic.at(-1)!.description).toBe("Desk mode off");
	expect(await first.visible("ses_main")).toEqual(["read"]);
	// Its last session in desk mode gone, the first instance hangs up; the second still has ses_main on.
	const page = JSON.parse(await readFile(join(home, "service.json"), "utf8")).url as string;
	const view = async () => Array.from(await rpc(page, (desk) => desk.view({}).pipe(Stream.take(1), Stream.runCollect)))[0]!;
	await eventually(async () => (await view()).opencode === 1);
	expect(await view()).toMatchObject({ deskMode: ["ses_main"] });
});

test("the service exits once every plugin instance has gone", async () => {
	for (const cleanup of cleanups) await cleanup();
	cleanups = [];
	// Watch the log: probing the socket would make a client and keep the service up.
	await eventually(async () => (await readFile(join(home, "service.log"), "utf8")).includes("desk: exiting"), 5000);
	await Bun.sleep(100);
	expect(await answering(join(home, "desk.sock"))).toBe(false);
	expect((await readdir(home)).filter((name) => name.endsWith(".md"))).toHaveLength(2);
});

test("a stuck service: /desk-mode and the tools fail after the timeout instead of waiting for good", async () => {
	const stuck = await mkdtemp(join(tmpdir(), "desk-stuck-"));
	// Takes connections, never answers.
	const listener = Bun.listen({ unix: join(stuck, "desk.sock"), socket: { data() {} } });
	const context = fakeContext(stuck, sessions, { timeout: "300 millis" });
	const unload = await load(context);
	try {
		await expect(context.command("desk-mode", "ses_main")).rejects.toThrow("didn't answer within");
		context.storage.set("on/ses_main", true);
		await expect(context.tool("desk_list", "ses_main", {})).rejects.toThrow("didn't answer within");
	} finally {
		await unload();
		listener.stop(true);
		await rm(stuck, { recursive: true, force: true });
	}
});
