/**
 * Storage, the same behaviors on both implementations (memory and the files), then what only the files do: their
 * format, someone else's edit, the lock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { type Entry, fileName, serialize } from "../src/model/entry";
import { type Content, Storage } from "../src/service/storage/storage";
import { E, S } from "./support/ids";
import { present } from "./support/present";
import { eventually } from "./support/service";

/** A readable name made an entry id (a UUID: on disk, only files named after one are entries). */
const id = (name: string) => E(`00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0")}`);
const entry = (name: string, created: string, title = name): Entry => ({
	id: id(name),
	parent: null,
	asker: "agent",
	status: "open",
	session: S("ses_a"),
	directory: "/w",
	labels: ["design"],
	priority: "high",
	created,
	title,
	question: "The question.",
	answer: null,
	pending: null,
});
/** The content's text; undefined when there's none. */
const text = (content: Option.Option<Content>) =>
	Effect.map(
		Effect.forEach(Option.toArray(content), ({ data }) => Effect.promise(() => data.text())),
		(texts) => texts[0],
	);

/** Directories made for a test, removed after it. */
const made: Array<string> = [];
afterEach(async () => {
	for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true });
});
const temp = async () => {
	const directory = await mkdtemp(join(tmpdir(), "desk-storage-"));
	made.push(directory);
	return directory;
};

/** A store, and a directory (an entry's) holding `files` (path below it → text). */
interface Fixture {
	readonly layer: Layer.Layer<Storage, unknown>;
	readonly directory: string;
}
const implementations: ReadonlyArray<readonly [string, (files: Record<string, string>) => Promise<Fixture>]> = [
	[
		"memory",
		async (files) => ({
			layer: Storage.layerMemory({
				files: Object.fromEntries(Object.entries(files).map(([below, data]) => [join("/work", below), data])),
			}),
			directory: "/work",
		}),
	],
	[
		"files",
		async (files) => {
			const directory = await temp();
			for (const [below, data] of Object.entries(files)) {
				await mkdir(join(directory, below, ".."), { recursive: true });
				await writeFile(join(directory, below), data);
			}
			return { layer: Storage.layer(await temp()).pipe(Layer.provide(BunServices.layer)), directory };
		},
	],
];

const run = <A, E>(fixture: Fixture, effect: Effect.Effect<A, E, Storage>) =>
	Effect.runPromise(Effect.provide(effect, fixture.layer));

for (const [name, open] of implementations) {
	describe(`on ${name}`, () => {
		test("entries round-trip, by `created` then id; removed ones are gone", async () => {
			const fixture = await open({});
			const all = [entry("b", "2026-01-01"), entry("a", "2026-01-01"), entry("c", "2025-12-31")];
			const read = await run(
				fixture,
				Storage.use((storage) =>
					Effect.gen(function* () {
						yield* storage.transact((_, store) => Effect.forEach(all, store.write, { discard: true }));
						const written = yield* storage.entries;
						yield* storage.transact((_, store) => store.remove(id("a")));
						return { written, after: yield* storage.entries };
					}),
				),
			);
			expect(read.written).toEqual([all[2], all[1], all[0]].map(present));
			expect(read.after.map((one) => one.id)).toEqual([id("c"), id("b")]);
		});

		test("transactions run one at a time, each on the entries the one before it left", async () => {
			const fixture = await open({});
			const result = await run(
				fixture,
				Storage.use((storage) =>
					Effect.gen(function* () {
						const inside = yield* Ref.make(0);
						const most = yield* Ref.make(0);
						const seen = yield* Effect.forEach(
							["x", "y", "z"],
							(id) =>
								storage.transact((all, store) =>
									Effect.gen(function* () {
										const now = yield* Ref.updateAndGet(inside, (n) => n + 1);
										yield* Ref.update(most, (n) => Math.max(n, now));
										yield* Effect.sleep("10 millis");
										yield* store.write(entry(id, "2026-01-01"));
										yield* Ref.update(inside, (n) => n - 1);
										return all.length;
									}),
								),
							{ concurrency: "unbounded" },
						);
						return { seen: [...seen].sort(), most: yield* Ref.get(most) };
					}),
				),
			);
			expect(result).toEqual({ seen: [0, 1, 2], most: 1 });
		});

		test("changes fires at the start and after every transaction, a failed one too", async () => {
			const fixture = await open({});
			const signals = await run(
				fixture,
				Storage.use((storage) =>
					Effect.gen(function* () {
						const signals = yield* Queue.unbounded<void>();
						yield* storage.changes.pipe(
							Stream.runForEach(() => Queue.offer(signals, undefined)),
							Effect.forkScoped,
						);
						const next = Effect.timeout(Queue.take(signals), "2 seconds");
						yield* next;
						yield* storage.transact((_, store) => store.write(entry("a", "2026-01-01")));
						yield* next;
						yield* Effect.exit(storage.transact(() => Effect.fail("refused")));
						yield* next;
						return 3;
					}),
				).pipe(Effect.scoped),
			);
			expect(signals).toBeGreaterThanOrEqual(3);
		});

		test("attachments: stored below attachments/, read back, deleted; a failed transaction leaves none; nothing outside attachments/", async () => {
			const fixture = await open({});
			const result = await run(
				fixture,
				Storage.use((storage) =>
					Effect.gen(function* () {
						const bytes = new TextEncoder().encode("PNGDATA");
						const file = yield* storage.transact((_, store) => store.attach("Shot.PNG", bytes));
						const stored = yield* text(yield* storage.attachment(file));
						const failed = yield* Ref.make("");
						yield* Effect.exit(
							storage.transact((_, store) =>
								Effect.andThen(
									Effect.tap(store.attach("b.gif", bytes), (other) => Ref.set(failed, other)),
									Effect.die("disk full"),
								),
							),
						);
						const afterFailure = yield* storage.attachment(yield* Ref.get(failed));
						const outside = yield* Effect.forEach(
							["attachments/../service.json", `../${file}`, "service.json", "attachments"],
							(path) => Effect.map(storage.attachment(path), Option.isSome),
						);
						yield* storage.transact((_, store) => store.detach([file, "attachments/missing.png"]));
						return { file, stored, afterFailure, outside, deleted: yield* storage.attachment(file) };
					}),
				),
			);
			expect(result.file).toMatch(/^attachments\/[0-9a-f-]{36}\.png$/);
			expect(result.stored).toBe("PNGDATA");
			expect(Option.isNone(result.afterFailure)).toBe(true);
			expect(result.outside).toEqual([false, false, false, false]);
			expect(Option.isNone(result.deleted)).toBe(true);
		});

		test("files below an entry's directory are read; missing ones are none; one outside it is refused", async () => {
			const fixture = await open({ "media/a.txt": "inside" });
			const result = await run(
				fixture,
				Storage.use((storage) =>
					Effect.gen(function* () {
						return {
							inside: yield* text(yield* storage.file(fixture.directory, "media/a.txt")),
							missing: Option.isNone(yield* storage.file(fixture.directory, "media/b.txt")),
							outside: yield* Effect.flip(storage.file(fixture.directory, "../etc/hosts")),
							absolute: yield* Effect.flip(storage.file(fixture.directory, "/etc/hosts")),
						};
					}),
				),
			);
			expect(result.inside).toBe("inside");
			expect(result.missing).toBe(true);
			expect(result.outside._tag).toBe("Outside");
			expect(result.absolute._tag).toBe("Outside");
		});
	});
}

describe("on files only", () => {
	const onDisk = (root: string) => Storage.layer(root).pipe(Layer.provide(BunServices.layer));

	test("an entry is a whole file, <id>.md; other files and unparseable ones aren't entries", async () => {
		const root = await temp();
		const one = entry("a", "2026-01-01");
		await writeFile(join(root, `${id("b")}.md`), "not an entry");
		await writeFile(join(root, "notes.txt"), "not one either");
		const read = await Effect.runPromise(
			Storage.use((storage) =>
				Effect.andThen(
					storage.transact((_, store) => store.write(one)),
					storage.entries,
				),
			).pipe(Effect.provide(onDisk(root))),
		);
		expect(read).toEqual([one]);
		expect(await readFile(join(root, fileName(one.id)), "utf8")).toBe(serialize(one));
		// Written beside it and renamed: nothing's left beside it.
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("an edit made to an entry's file by someone else is a change", async () => {
		const root = await temp();
		const one = entry("a", "2026-01-01");
		const signals: Array<number> = [];
		const fiber = Effect.runFork(
			Storage.use((storage) =>
				Effect.andThen(
					storage.transact((_, store) => store.write(one)),
					storage.changes.pipe(Stream.runForEach(() => Effect.sync(() => signals.push(Date.now())))),
				),
			).pipe(Effect.provide(Storage.layer(root, "1 hour").pipe(Layer.provide(BunServices.layer)))),
		);
		await eventually(() => signals.length >= 1);
		await Bun.sleep(100);
		const count = signals.length;
		await writeFile(join(root, fileName(one.id)), serialize({ ...one, title: "Edited" }));
		await eventually(() => signals.length > count);
		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	test("it holds the store's lock: a second storage on the same store fails, and where the page is goes into service.json", async () => {
		const root = await temp();
		const result = await Effect.runPromise(
			Storage.use((storage) =>
				Effect.gen(function* () {
					yield* storage.publish({ url: "http://127.0.0.1:1/", socket: join(root, "desk.sock") });
					const second = yield* Effect.exit(Effect.scoped(Layer.build(onDisk(root))));
					return {
						second,
						registered: JSON.parse(yield* Effect.promise(() => readFile(join(root, "service.json"), "utf8"))),
					};
				}),
			).pipe(Effect.provide(onDisk(root))),
		);
		expect(Exit.isFailure(result.second) && String(result.second.cause)).toContain("AlreadyRunning");
		expect(result.registered).toMatchObject({ pid: process.pid, url: "http://127.0.0.1:1/" });
	}, 10_000);

	test("an attachment's URL for the session is its file below the store", async () => {
		const root = await temp();
		const [file, url] = await Effect.runPromise(
			Storage.use((storage) =>
				Effect.gen(function* () {
					const file = yield* storage.transact((_, store) => store.attach("a.png", new Uint8Array([1])));
					return [file, yield* storage.attachmentUrl(file)] as const;
				}),
			).pipe(Effect.provide(onDisk(root))),
		);
		expect(url).toBe(`file://${root}/${file}`);
	});
});
