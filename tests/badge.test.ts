/** The TUI badge's data (`src/tui/badge.ts`): read from the service on the port setting, through restarts. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { count, page, report, type Status, watch } from "../src/tui/badge";
import { S } from "./support/ids";
import { present } from "./support/present";
import { eventually, startService } from "./support/service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Every status `watch` gives for `port`, as they come. */
const watching = (port: number) => {
	const seen: Array<Status | undefined> = [];
	const fiber = Effect.runFork(
		Stream.runForEach(watch(port, Schedule.spaced("20 millis")), (status) => Effect.sync(() => seen.push(status))).pipe(
			Effect.provide(RpcSerialization.layerNdjson),
		),
	);
	cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
	return { seen, latest: () => seen.at(-1) };
};

/** A port nothing listens on now. */
const freePort = async () => {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = present(probe.port);
	await probe.stop(true);
	return port;
};

test("the badge finds the service by the port setting: it counts a desk's entries waiting on the user, knows the sessions in desk mode, and follows the service through a restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "desk-badge-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const port = await freePort();
	const { seen, latest } = watching(port);
	// No service yet: nothing to show.
	await eventually(() => seen.length > 0);
	expect(latest()).toBeUndefined();

	const first = await startService({ store: home, port });
	// An OpenCode whose session ses_a is in desk mode (the test plugin reports every session its OpenCode knows).
	const opencode = first.fake.server("http://opencode");
	opencode.session({ id: S("ses_a") });
	const plugin = first.plugin(opencode);
	const asked = { session: S("ses_a"), directory: "/work/a" };
	await plugin.request("ask", { by: asked, question: { title: "One?", body: "" } });
	await plugin.request("ask", { by: asked, question: { title: "Two?", body: "", priority: "critical" } });
	const counted = await eventually(() =>
		latest()?.desks.find((desk) => desk.session === "ses_a" && desk.waiting === 2),
	);
	expect(present(latest())).toMatchObject({ url: page(port), deskMode: ["ses_a"] });
	expect(first.url).toBe(page(port));
	expect(count(counted)).toEqual({ waiting: 2, critical: 1 });
	// Not through the registration: that names the page too, but the badge doesn't read it.
	expect(JSON.parse(await readFile(join(home, "service.json"), "utf8")).url).toBe(page(port));

	// The service goes; the badge hides, then finds the next one on the same port.
	await first.close(false);
	await eventually(() => latest() === undefined);
	const second = await startService({ store: home, port });
	cleanup.push(() => second.close(false));
	const back = await eventually(() => latest());
	expect(back).toMatchObject({ url: page(port), deskMode: [] });
	expect(back.desks).toHaveLength(1);
});

test("a service on another port isn't the badge's", async () => {
	const elsewhere = await startService();
	cleanup.push(() => elsewhere.close());
	const port = await freePort();
	const { seen, latest } = watching(port);
	await eventually(() => seen.length > 0);
	await Bun.sleep(100);
	expect(latest()).toBeUndefined();
	expect(elsewhere.port).not.toBe(port);
});

test("the count: none when nothing waits on the user, else how many and how many of those are critical", () => {
	const summary = { session: "ses_a", title: "A", folder: "a", known: true };
	expect(count(undefined)).toBeUndefined();
	expect(count({ ...summary, waiting: 0, critical: 0 })).toBeUndefined();
	expect(count({ ...summary, waiting: 3, critical: 1 })).toEqual({ waiting: 3, critical: 1 });
});

test("the report for a desk: its page and count while its session is in desk mode, else nothing", () => {
	const summary = { session: "ses_a", title: "A", folder: "a", known: true, waiting: 2, critical: 0 };
	const status = { url: "http://127.0.0.1:47400/", desks: [summary], deskMode: ["ses_a"] };
	expect(report(status, "ses_a")).toEqual({
		page: "http://127.0.0.1:47400/sessions/ses_a",
		count: { waiting: 2, critical: 0 },
	});
	expect(report({ ...status, desks: [] }, "ses_a")).toEqual({
		page: "http://127.0.0.1:47400/sessions/ses_a",
		count: undefined,
	});
	expect(report(status, "ses_b")).toBeUndefined();
	expect(report(status, undefined)).toBeUndefined();
	expect(report(undefined, "ses_a")).toBeUndefined();
});
