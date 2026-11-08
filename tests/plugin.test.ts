/**
 * The plugin through its `setup(ctx)`, with a fake plugin context standing in for OpenCode and a real desk service,
 * which the plugin starts itself (detached) on a temporary store.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/plugin/index";
import { answering } from "../src/service/socket";
import { eventually } from "./support/service";

interface Session {
	id: string;
	parentID?: string;
	location: { directory: string };
}

/** The parts of the plugin context the desk uses, recording what the plugin registers and says. */
function fakeContext(home: string, sessions: Array<Session>) {
	const tools = new Map<string, { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> }>();
	const commands = new Map<string, { execute: (input: { sessionID: string }) => Promise<void> }>();
	const hooks: Array<(event: { sessionID: string; tools: Record<string, unknown> }) => Promise<void> | void> = [];
	const storage = new Map<string, unknown>();
	const synthetic: Array<{ sessionID: string; text: string }> = [];
	const ctx = {
		options: { home, port: 0 },
		location: { directory: "/work/phantom", project: { id: "prj_phantom", directory: "/work/phantom" } },
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => void storage.set(key, value),
			remove: async (key: string) => void storage.delete(key),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions.find((candidate) => candidate.id === sessionID);
				if (!session) throw new Error(`Session not found: ${sessionID}`);
				return session;
			},
			synthetic: async (input: { sessionID: string; text: string }) => void synthetic.push(input),
			hook: async (_name: "context", callback: (typeof hooks)[number]) => void hooks.push(callback),
		},
		tool: { transform: async (callback: (editor: { add: (tool: { name: string } & Parameters<typeof tools.set>[1]) => void }) => void) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
		command: { transform: async (callback: (editor: { add: (command: { name: string } & Parameters<typeof commands.set>[1]) => void }) => void) => callback({ add: (command) => commands.set(command.name, command) }) },
	};
	return {
		ctx,
		storage,
		synthetic,
		tools,
		/** The tools a model request in `sessionID` gets, after the plugin's context hook. */
		async visible(sessionID: string) {
			const event = { sessionID, tools: Object.fromEntries([...tools.keys(), "read"].map((name) => [name, {}])) };
			for (const hook of hooks) await hook(event);
			return Object.keys(event.tools).sort();
		},
		command: (name: string, sessionID: string) => commands.get(name)!.execute({ sessionID }),
		tool: (name: string, sessionID: string, input: unknown) => tools.get(name)!.execute(input, { sessionID }),
	};
}

const sessions: Array<Session> = [
	{ id: "ses_main", location: { directory: "/work/phantom" } },
	{ id: "ses_sub", parentID: "ses_main", location: { directory: "/work/phantom" } },
	{ id: "ses_other", location: { directory: "/work/phantom" } },
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
	cleanups.push((await plugin.setup(first.ctx as never)) as () => unknown);
});

afterAll(async () => {
	for (const cleanup of cleanups) await cleanup();
	if (previousIdle === undefined) delete process.env.DESK_IDLE;
	else process.env.DESK_IDLE = previousIdle;
	await eventually(async () => (await readFile(join(home, "service.log"), "utf8").catch(() => "")).includes("exiting"), 5000).catch(() => {});
	await rm(home, { recursive: true, force: true });
});

test("off by default: a session sees no desk tools until /desk turns the desk on, for its subagents too", async () => {
	expect(await first.visible("ses_main")).toEqual(["read"]);
	await first.command("desk", "ses_main");
	expect(first.storage.get("on/ses_main")).toBe(true);
	expect(first.synthetic.at(-1)!.text).toMatch(/The desk is on for this session.*http:\/\/127\.0\.0\.1:\d+\/\?project=/);
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

test("a second plugin instance (another OpenCode) shares the one service and the switch", async () => {
	const second = fakeContext(home, sessions);
	second.storage.set("on/ses_main", true); // OpenCode's plugin storage is shared; here each fake has its own
	cleanups.push((await plugin.setup(second.ctx as never)) as () => unknown);
	expect((await second.tool("desk_list", "ses_main", {})).content).toContain("From a subagent?");
	const log = await readFile(join(home, "service.log"), "utf8");
	expect(log.match(/desk: serving/g)).toHaveLength(1);
});

test("/desk again turns it off", async () => {
	await first.command("desk", "ses_sub");
	expect(first.storage.has("on/ses_main")).toBe(false);
	expect(first.synthetic.at(-1)!.text).toContain("The desk is off");
	expect(await first.visible("ses_main")).toEqual(["read"]);
});

test("the service exits once every plugin instance has gone", async () => {
	for (const cleanup of cleanups) await cleanup();
	cleanups = [];
	// Watch the log: probing the socket would make a client and keep the service up.
	await eventually(async () => (await readFile(join(home, "service.log"), "utf8")).includes("no clients left; exiting"), 5000);
	await Bun.sleep(100);
	expect(await answering(join(home, "desk.sock"))).toBe(false);
	expect((await readdir(home)).filter((name) => name.endsWith(".md"))).toHaveLength(1);
});
