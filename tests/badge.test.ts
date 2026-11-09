/** The TUI badge's data (`src/badge.ts`): read from whichever service is registered, through restarts. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { count, type Status, watch } from "../src/badge";
import { eventually, type Service, startService } from "./support/service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Every status `watch` gives for `home`, as they come. */
const watching = (home: string) => {
	const seen: Array<Status | undefined> = [];
	const fiber = Effect.runFork(Stream.runForEach(watch(home, Schedule.spaced("20 millis")), (status) => Effect.sync(() => seen.push(status))));
	cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
	return { seen, latest: () => seen.at(-1) };
};

const register = (service: Service) => writeFile(join(service.store, "service.json"), JSON.stringify({ url: service.url }));

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
	opencode.session({ id: "ses_a" });
	const plugin = first.plugin(opencode);
	const asked = { session: "ses_a", directory: "/work/a" };
	await plugin.request("ask", { asker: asked, question: { title: "One?", body: "" } });
	await plugin.request("ask", { asker: asked, question: { title: "Two?", body: "", priority: "critical" } });
	const counted = await eventually(() => latest()?.projects.find((project) => project.waiting === 2));
	expect(latest()!).toMatchObject({ url: first.url, deskMode: ["ses_a"] });
	expect(count(counted)).toEqual({ waiting: 2, critical: 1 });

	// The service goes (its registration first, as `registration.ts` does); the badge hides, then finds the next one.
	await rm(join(home, "service.json"));
	await first.close(false);
	await eventually(() => latest() === undefined);
	const second = await startService({ store: home });
	cleanup.push(() => rm(join(home, "service.json"), { force: true }).then(() => second.close(false)));
	await register(second);
	await eventually(() => latest()?.url === second.url);
	expect(latest()!.projects).toHaveLength(1);
});

test("the count: none when nothing waits on the user, else how many and how many of those are critical", () => {
	const summary = { id: "p", name: "p", guessed: false };
	expect(count(undefined)).toBeUndefined();
	expect(count({ ...summary, waiting: 0, critical: 0 })).toBeUndefined();
	expect(count({ ...summary, waiting: 3, critical: 1 })).toEqual({ waiting: 3, critical: 1 });
});
