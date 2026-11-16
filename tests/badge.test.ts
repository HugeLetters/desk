/**
 * The TUI badge's data: what the plugin's server part answers for a session (`src/plugin/badge.ts`: its desk, from the
 * service its connection is live to, through restarts, while the desk is in desk mode), and how the TUI asks for it
 * (`src/tui/badge.ts`: per session, of its directory's instance, again on that instance's `changed`).
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionNotFoundError } from "@opencode/protocol/errors";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { View } from "../src/api/api";
import type { SessionID } from "../src/model/entry";
import { Port } from "../src/model/paths";
import * as Badge from "../src/plugin/badge";
import { BadgeRpc, type Status } from "../src/plugin/badge-rpc";
import * as Connection from "../src/plugin/connection";
import { OpenCodeError } from "../src/plugin/sessions";
import { count, follow } from "../src/tui/badge";
import tui from "../src/tui/index";
import { rpcClient } from "../src/tui/rpc-client";
import { D, S } from "./support/ids";
import { present } from "./support/present";
import { eventually, startService } from "./support/service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The page on `port`. */
const page = (port: number) => new URL(`http://127.0.0.1:${port}/`);

/** The store's token, as the services here have it. */
const token = Redacted.make("badge-token");

/** A port nothing listens on now. */
const freePort = async () => {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = Port.make(present(probe.port));
	await probe.stop(true);
	return port;
};

/** ses_sub is ses_a's subagent; ses_fails is one OpenCode can't look up now; ses_gone, one it doesn't know. */
const roots = (session: SessionID) =>
	session === "ses_sub"
		? Effect.succeed(S("ses_a"))
		: session === "ses_fails"
			? Effect.fail(new OpenCodeError({ message: "OpenCode is busy", cause: null }))
			: session === "ses_gone"
				? Effect.fail(new SessionNotFoundError({ sessionID: session, message: `Session not found: ${session}` }))
				: Effect.succeed(session);

/**
 * A plugin instance on `port` with the badge's RPC registered, as the TUI reaches it: its connection is needed from the
 * start, with the sessions in `on` in desk mode, and doesn't start a service (the test does).
 */
const registered = (port: Port, on: Set<string>) => {
	const scope = Effect.runSync(Scope.make());
	let handlers: { status: (input: unknown, context: unknown) => Effect.Effect<unknown, unknown> } | undefined;
	const changed: Array<unknown> = [];
	const ctx = {
		rpc: {
			register: (_definition: unknown, registering: typeof handlers) =>
				Effect.sync(() => {
					handlers = registering;
					return {
						dispose: Effect.void,
						events: { emit: (name: string, data: unknown) => Effect.sync(() => void changed.push([name, data])) },
					};
				}),
		},
	} as never;
	Effect.runSync(
		Scope.provide(
			Effect.gen(function* () {
				const connection = yield* Connection.make({
					port,
					start: Effect.void,
					directory: D("/work/a"),
					token: Effect.succeed(token),
					modes: Effect.succeed([S("ses_a")]),
					serve: { session: () => Effect.succeed(null), prompt: () => Effect.void },
					timeout: 200,
					needed: true,
				});
				yield* Badge.register(ctx, {
					connection,
					modes: { on: (session) => Effect.succeed(on.has(session)) },
					getRootSessionId: roots,
				});
			}),
			scope,
		),
	);
	cleanup.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
	const error = (type: string, message: string, data: unknown) => ({ type, message, data });

	return {
		/** `session`'s badge, encoded, as OpenCode's plugin RPC sends it. */
		status: (session: string) =>
			Effect.runPromise(
				Effect.flatMap(
					present(handlers).status({ session }, { error }),
					Schema.encodeUnknownEffect(BadgeRpc.methods.status.output),
				),
			),
		/** What `status` fails with for `session`. */
		failure: (session: string) => Effect.runPromise(Effect.flip(present(handlers).status({ session }, { error }))),
		changed,
	};
};

test("the plugin answers a session's badge with its desk on the service it's connected to: the page, the entries waiting on the user, through a restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "desk-badge-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const port = await freePort();
	const on = new Set(["ses_a"]);
	const plugin = registered(port, on);
	// No service yet: not connected, nothing to show; the TUI was told to ask.
	await eventually(() => plugin.changed.length > 0);
	expect(plugin.changed[0]).toEqual(["changed", {}]);
	expect(await plugin.status("ses_a")).toBeNull();

	const first = await startService({ store: home, port, token });
	const opencode = first.fake.server("http://opencode");
	opencode.session({ id: S("ses_a") });
	const asking = first.plugin(opencode);
	const asked = { session: S("ses_a"), directory: D("/work/a") };
	await asking.request("ask", { by: asked, question: { title: "One?", body: "" } });
	await asking.request("ask", { by: asked, question: { title: "Two?", body: "", priority: "critical" } });
	// Its page lets the browser in: it carries the token.
	const desk = { page: `${page(port).href}sessions/ses_a?token=badge-token`, waiting: 2, critical: 1 };
	await eventually(async () => (await plugin.status("ses_a"))?.waiting === 2);
	expect(await plugin.status("ses_a")).toEqual(desk);
	// A subagent's badge is its top-level session's desk.
	expect(await plugin.status("ses_sub")).toEqual(desk);
	// Desk mode off for that desk: no badge, though the instance is still connected.
	on.delete("ses_a");
	expect(await plugin.status("ses_a")).toBeNull();
	expect(await plugin.status("ses_sub")).toBeNull();
	on.add("ses_a");
	// A session in desk mode with nothing on its desk: its page, nothing waiting.
	on.add("ses_b");
	expect(await plugin.status("ses_b")).toEqual({
		page: `${page(port).href}sessions/ses_b?token=badge-token`,
		waiting: 0,
		critical: 0,
	});

	// The service goes: not connected, so the badge hides, and the TUI is told; then the connection finds the next
	// one on the same port.
	const before = plugin.changed.length;
	await first.close(false);
	await eventually(async () => (await plugin.status("ses_a")) === null);
	expect(plugin.changed.length).toBeGreaterThan(before);
	const second = await startService({ store: home, port, token });
	cleanup.push(() => second.close(false));
	await eventually(async () => (await plugin.status("ses_a")) !== null);
	expect(await plugin.status("ses_a")).toMatchObject({ page: desk.page, waiting: 2 });
});

test("a session OpenCode doesn't know has no badge; one it can't look up now fails, so the TUI asks again", async () => {
	const plugin = registered(await freePort(), new Set(["ses_gone", "ses_fails"]));
	expect(await plugin.status("ses_gone")).toBeNull();
	expect(await plugin.failure("ses_fails")).toEqual({ type: "opencode", message: "OpenCode is busy", data: {} });
});

test("a service on another port isn't the plugin's, so no badge", async () => {
	const elsewhere = await startService();
	cleanup.push(() => elsewhere.close());
	const port = await freePort();
	const plugin = registered(port, new Set(["ses_a"]));
	await eventually(() => plugin.changed.length > 0);
	await Bun.sleep(300);
	expect(await plugin.status("ses_a")).toBeNull();
	expect(elsewhere.port).not.toBe(port);
});

test("a desk's badge out of the service's view: its page and counts, none waiting when the view has no summary for it", () => {
	const view: View = {
		desk: null,
		entries: [],
		desks: [{ session: "ses_a", title: "Phantom", folder: "phantom", known: true, waiting: 2, critical: 1 }],
		deskMode: ["ses_a"],
		failures: {},
	};
	const seen = { url: page(1), token, view };
	expect(Badge.fromView(seen, S("ses_a"))).toEqual({
		page: new URL("http://127.0.0.1:1/sessions/ses_a?token=badge-token"),
		waiting: 2,
		critical: 1,
	});
	expect(Badge.fromView(seen, S("ses_b"))).toEqual({
		page: new URL("http://127.0.0.1:1/sessions/ses_b?token=badge-token"),
		waiting: 0,
		critical: 0,
	});
});

test("the count: none when nothing waits on the user, else how many and how many of those are critical", () => {
	const at = new URL("http://127.0.0.1:1/sessions/ses_a");
	expect(count({ page: at, waiting: 0, critical: 0 })).toBeUndefined();
	expect(count({ page: at, waiting: 3, critical: 1 })).toEqual({ waiting: 3, critical: 1 });
});

/** The TUI client's `rpc`: `status` answers each session's badge from `badges`, recording each call; `emit` sends `changed`. */
const fakeClient = (badges: Map<string, Status | null>) => {
	const listeners: Array<(event: unknown) => void> = [];
	const calls: Array<[unknown, unknown]> = [];
	const rpc = () => ({
		status: (input: { session: string }, options: { location?: { directory: string } }) => {
			calls.push([input.session, options.location?.directory]);
			return Promise.resolve(Schema.encodeSync(BadgeRpc.methods.status.output)(badges.get(input.session) ?? null));
		},
		events: {
			on: (_name: string, listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => void listeners.splice(listeners.indexOf(listener), 1);
			},
		},
	});
	const context = { client: { rpc }, location: { directory: "/work/tui" } } as never;
	const emit = (directory: string) => {
		for (const listener of listeners) listener({ type: "rpc.desk.changed", location: { directory }, data: {} });
	};
	return { client: rpcClient(BadgeRpc, context), calls, emit };
};

test("the TUI asks per session, of its directory's instance, and again on that instance's changed and on a reconnect", async () => {
	const badge = (session: string, waiting: number): Status => ({
		page: new URL(`http://127.0.0.1:1/sessions/${session}`),
		waiting,
		critical: 0,
	});
	const badges = new Map<string, Status | null>([
		["ses_a", badge("ses_a", 1)],
		["ses_b", null],
	]);
	const fake = fakeClient(badges);
	const reconnects = Effect.runSync(PubSub.unbounded<void>());
	const seen: Record<string, Array<Status | null>> = { ses_a: [], ses_b: [] };
	const slot = (session: string, directory: string) => {
		const fiber = Effect.runFork(
			follow(fake.client, S(session), directory, Stream.fromPubSub(reconnects)).pipe(
				Stream.runForEach((now) => Effect.sync(() => void present(seen[session]).push(now))),
			),
		);
		cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
	};
	slot("ses_a", "/work/a");
	slot("ses_b", "/work/b");
	await eventually(() => seen.ses_a?.length === 1 && seen.ses_b?.length === 1);
	expect(fake.calls).toEqual(
		expect.arrayContaining([
			["ses_a", "/work/a"],
			["ses_b", "/work/b"],
		]),
	);
	expect(seen).toEqual({ ses_a: [badge("ses_a", 1)], ses_b: [null] });

	// /work/a's instance says something changed: only ses_a's slot asks again.
	badges.set("ses_a", badge("ses_a", 2));
	fake.emit("/work/a");
	await eventually(() => seen.ses_a?.length === 2);
	await Bun.sleep(20);
	expect(seen).toEqual({ ses_a: [badge("ses_a", 1), badge("ses_a", 2)], ses_b: [null] });
	expect(fake.calls).toHaveLength(3);

	// OpenCode's server reconnected: both ask again.
	badges.set("ses_b", badge("ses_b", 1));
	Effect.runSync(PubSub.publish(reconnects, undefined));
	await eventually(() => seen.ses_b?.length === 2);
	await eventually(() => seen.ses_a?.length === 3);
	expect(seen.ses_b?.at(-1)).toEqual(badge("ses_b", 1));
});

test("the TUI's badge stays hidden while a setting isn't valid, and logs why once; with valid ones it takes its slot", async () => {
	const load = async (options: Record<string, unknown>) => {
		const slots: Array<unknown> = [];
		const context = {
			options,
			client: { rpc: () => ({}) },
			location: { directory: "/work/tui" },
			data: { on: () => () => {} },
			ui: {
				slot: (slot: unknown) => {
					slots.push(slot);
					return () => {};
				},
			},
		} as never;
		const logged: Array<string> = [];
		const record = (...parts: Array<unknown>) => void logged.push(parts.join(" "));
		const spies = [
			spyOn(console, "error").mockImplementation(record),
			spyOn(console, "log").mockImplementation(record),
			spyOn(console, "warn").mockImplementation(record),
		];
		try {
			const unload = tui.setup(context);
			await Bun.sleep(100);
			await (await unload)?.();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		return { slots, logged };
	};

	const invalid = await load({ port: "nope" });
	expect(invalid.slots).toHaveLength(0);
	const why = invalid.logged.filter((line) => line.includes("The desk's `port` option isn't valid"));
	expect(why).toHaveLength(1);
	expect(why[0]).toContain("Fix it in opencode.json (or DESK_PORT) and /reload.");

	expect((await load({})).slots).toHaveLength(1);
});
