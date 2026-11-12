/** The TUI badge's data (`src/badge.ts`): read from whichever service is registered, through restarts. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { count, report, type Status, watch } from "../src/badge";
import { S } from "./support/ids";
import { present } from "./support/present";
import { eventually, type Service, startService } from "./support/service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Every status `watch` gives for `home`, as they come. */
const watching = (home: string) => {
	const seen: Array<Status | undefined> = [];
	const fiber = Effect.runFork(
		Stream.runForEach(watch(home, Schedule.spaced("20 millis")), (status) => Effect.sync(() => seen.push(status))).pipe(
			Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, RpcSerialization.layerNdjson)),
		),
	);
	cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
	return { seen, latest: () => seen.at(-1) };
};

const register = (service: Service) =>
	writeFile(
		join(service.store, "service.json"),
		JSON.stringify({ pid: process.pid, protocol: "test", url: service.url }),
	);

test("the badge counts a project's entries waiting on the user, knows the sessions in desk mode, and follows the service through a restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "desk-badge-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const { seen, latest } = watching(home);
	// No service yet: nothing to show.
	await eventually(() => seen.length > 0);
	expect(latest()).toBeUndefined();

	const first = await startService({ store: home });
	await register(first);
	// An OpenCode whose session ses_a is in desk mode (the test plugin reports every session its OpenCode knows).
	const opencode = first.fake.server("http://opencode");
	opencode.session({ id: S("ses_a") });
	const plugin = first.plugin(opencode);
	const asked = { session: S("ses_a"), directory: "/work/a" };
	await plugin.request("ask", { asker: asked, question: { title: "One?", body: "" } });
	await plugin.request("ask", { asker: asked, question: { title: "Two?", body: "", priority: "critical" } });
	const counted = await eventually(() =>
		latest()?.desks.find((desk) => desk.session === "ses_a" && desk.waiting === 2),
	);
	expect(present(latest())).toMatchObject({ url: first.url, deskMode: ["ses_a"] });
	expect(count(counted)).toEqual({ waiting: 2, critical: 1 });

	// The service goes (its registration first, as `registration.ts` does); the badge hides, then finds the next one.
	await rm(join(home, "service.json"));
	await first.close(false);
	await eventually(() => latest() === undefined);
	const second = await startService({ store: home });
	cleanup.push(() => rm(join(home, "service.json"), { force: true }).then(() => second.close(false)));
	await register(second);
	await eventually(() => latest()?.url === second.url);
	expect(present(latest()).desks).toHaveLength(1);
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
