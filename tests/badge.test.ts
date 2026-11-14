/**
 * The TUI badge's data: what the plugin's server part gives it (`src/plugin/badge.ts`: the desks of the service its
 * connection is live to, through restarts), and what the TUI makes of it (`src/tui/badge.ts`: which location's status a
 * session uses, and the report).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { statuses } from "../src/plugin/badge";
import { off, type Status } from "../src/plugin/badge-rpc";
import * as Connection from "../src/plugin/connection";
import { at, count, first, learn, report } from "../src/tui/badge";
import { S } from "./support/ids";
import { present } from "./support/present";
import { eventually, startService } from "./support/service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The page on `port`. */
const page = (port: number) => `http://127.0.0.1:${port}/`;

/**
 * Every status a plugin instance on `port` gives the badge, as they come: its connection is wanted from the start, with
 * ses_a in desk mode, and doesn't start a service (the test does).
 */
const watching = (port: number) => {
	const seen: Array<Status> = [];
	const scope = Effect.runSync(Scope.make());
	const connection = Effect.runSync(
		Scope.provide(
			Connection.make({
				port,
				start: Effect.void,
				directory: "/work/a",
				modes: Effect.succeed([S("ses_a")]),
				serve: { session: () => Effect.succeed(null), prompt: () => Effect.void },
				timeout: 200,
				wanted: true,
			}),
			scope,
		),
	);
	const fiber = Effect.runFork(
		Stream.runForEach(statuses(connection), (status) => Effect.sync(() => seen.push(status))),
	);
	cleanup.push(async () => {
		await Effect.runPromise(Fiber.interrupt(fiber));
		await Effect.runPromise(Scope.close(scope, Exit.void));
	});
	return { seen, latest: () => seen.at(-1) };
};

/** A port nothing listens on now. */
const freePort = async () => {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = present(probe.port);
	await probe.stop(true);
	return port;
};

test("the plugin gives the badge the desks of the service it's connected to: a desk's entries waiting on the user, the sessions in desk mode, through a restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "desk-badge-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const port = await freePort();
	const { seen, latest } = watching(port);
	// No service yet: not connected, nothing to show.
	await eventually(() => seen.length > 0);
	expect(latest()).toEqual(off);

	const first = await startService({ store: home, port });
	const opencode = first.fake.server("http://opencode");
	opencode.session({ id: S("ses_a") });
	const plugin = first.plugin(opencode);
	const asked = { session: S("ses_a"), directory: "/work/a" };
	await plugin.request("ask", { by: asked, question: { title: "One?", body: "" } });
	await plugin.request("ask", { by: asked, question: { title: "Two?", body: "", priority: "critical" } });
	const counted = await eventually(() =>
		latest()?.live?.desks.find((desk) => desk.session === "ses_a" && desk.waiting === 2),
	);
	expect(present(latest()?.live)).toMatchObject({ url: page(port), deskMode: ["ses_a"] });
	expect(count(counted)).toEqual({ waiting: 2, critical: 1 });
	expect(report(latest(), "ses_a")).toEqual({
		page: `${page(port)}sessions/ses_a`,
		count: { waiting: 2, critical: 1 },
	});

	// The service goes: not connected, so the badge hides; then the connection finds the next one on the same port.
	await first.close(false);
	await eventually(() => latest()?.live === null);
	expect(report(latest(), "ses_a")).toBeUndefined();
	const second = await startService({ store: home, port });
	cleanup.push(() => second.close(false));
	const back = await eventually(() => latest()?.live?.desks.length === 1 && latest()?.live);
	expect(back).toMatchObject({ url: page(port), deskMode: ["ses_a"] });
	// Each change once.
	expect(
		seen.filter((status, index) => index > 0 && JSON.stringify(status) === JSON.stringify(seen[index - 1])),
	).toEqual([]);
});

test("a service on another port isn't the plugin's, so nothing for the badge", async () => {
	const elsewhere = await startService();
	cleanup.push(() => elsewhere.close());
	const port = await freePort();
	const { seen, latest } = watching(port);
	await eventually(() => seen.length > 0);
	await Bun.sleep(300);
	expect(latest()).toEqual(off);
	expect(elsewhere.port).not.toBe(port);
});

test("the count: none when nothing waits on the user, else how many and how many of those are critical", () => {
	expect(count(undefined)).toBeUndefined();
	expect(count({ session: "ses_a", waiting: 0, critical: 0 })).toBeUndefined();
	expect(count({ session: "ses_a", waiting: 3, critical: 1 })).toEqual({ waiting: 3, critical: 1 });
});

test("the report for a desk: its page and count while its session is in desk mode and the plugin connected, else nothing", () => {
	const summary = { session: "ses_a", waiting: 2, critical: 0 };
	const live = { url: "http://127.0.0.1:47400/", desks: [summary], deskMode: ["ses_a"] };
	expect(report({ live }, "ses_a")).toEqual({
		page: "http://127.0.0.1:47400/sessions/ses_a",
		count: { waiting: 2, critical: 0 },
	});
	expect(report({ live: { ...live, desks: [] } }, "ses_a")).toEqual({
		page: "http://127.0.0.1:47400/sessions/ses_a",
		count: undefined,
	});
	expect(report({ live }, "ses_b")).toBeUndefined();
	expect(report({ live }, undefined)).toBeUndefined();
	expect(report(off, "ses_a")).toBeUndefined();
	expect(report(undefined, "ses_a")).toBeUndefined();
});

test("statuses per location: a session's badge uses its location's, the latest event wins, and a late first answer doesn't undo one", () => {
	const live = (waiting: number): Status => ({
		live: { url: "http://127.0.0.1:47400/", desks: [{ session: "ses_a", waiting, critical: 0 }], deskMode: ["ses_a"] },
	});
	const a = learn(learn({}, "/work/a", live(1)), "/work/b", off);
	expect(at(a, "/work/a")).toEqual(live(1));
	expect(at(a, "/work/b")).toEqual(off);
	// Not asked yet, or not loaded: nothing.
	expect(at(a, "/work/c")).toBeUndefined();
	expect(at(a, undefined)).toBeUndefined();
	expect(at(a, "constructor")).toBeUndefined();
	// Each location's its own: ses_a's desk shows from /work/a's instance, not /work/b's.
	expect(report(at(a, "/work/a"), "ses_a")?.count).toEqual({ waiting: 1, critical: 0 });
	expect(report(at(a, "/work/b"), "ses_a")).toBeUndefined();
	// An event replaces a location's status.
	const b = learn(a, "/work/a", live(2));
	expect(at(b, "/work/a")).toEqual(live(2));
	expect(at(a, "/work/a")).toEqual(live(1));
	// The first answer for a location counts only if no event came first.
	expect(at(first(b, "/work/a", off), "/work/a")).toEqual(live(2));
	expect(at(first(b, "/work/c", live(3)), "/work/c")).toEqual(live(3));
});
