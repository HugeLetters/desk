/** The registration is the store's lock: of services starting together, one holds it. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Starts `n` processes taking the store's registration at once; what each says. */
const race = async (store: string, n: number) => {
	const racers = Array.from({ length: n }, () =>
		Bun.spawn(["bun", join(import.meta.dir, "support", "register.ts"), store], { stdout: "pipe", stderr: "inherit" }),
	);
	return Promise.all(racers.map(async (racer) => (await new Response(racer.stdout).text()).trim()));
};

/** A pid no process has: one that just exited. */
const deadPid = async () => {
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	return gone.pid;
};

test("of services starting together, one holds the store, whether it was free or a dead service's file was there", async () => {
	for (const stale of [false, true]) {
		const store = await mkdtemp(join(tmpdir(), "desk-registration-"));
		if (stale) await writeFile(join(store, "service.json"), JSON.stringify({ pid: await deadPid(), protocol: "old" }));
		const said = await race(store, 8);
		expect(said.filter((line) => line === "held")).toHaveLength(1);
		expect(said.filter((line) => line === "taken")).toHaveLength(7);
		await rm(store, { recursive: true, force: true });
	}
}, 30_000);
