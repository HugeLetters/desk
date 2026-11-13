/**
 * The desk's rules, through `Desk`: on memory storage, but for what's about the files (a restart, someone else's edit),
 * on a temporary store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Refusal } from "../src/model/errors";
import { refusal } from "../src/model/wording";
import { Desk, type Question } from "../src/service/desk";
import { Storage } from "../src/service/storage/storage";
import { E, S } from "./support/ids";
import { present } from "./support/present";
import { eventually } from "./support/service";

let scope: Scope.Closeable;
let services: Context.Context<Desk | Storage>;

async function open(storage: Layer.Layer<Storage, unknown> = Storage.layerMemory()) {
	scope = Effect.runSync(Scope.make());
	services = (await Effect.runPromise(
		Layer.buildWithScope(Desk.layer.pipe(Layer.provideMerge(storage), Layer.provideMerge(BunServices.layer)), scope),
	)) as typeof services;
}
const onDisk = (root: string) => Storage.layer(root).pipe(Layer.provide(BunServices.layer));
const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
const desk = <A, E>(f: (desk: Desk["Service"]) => Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.provideContext(Desk.use(f), services));
const failure = async <A, E>(f: (desk: Desk["Service"]) => Effect.Effect<A, E>) => {
	const exit = await Effect.runPromiseExit(Effect.provideContext(Desk.use(f), services));
	if (Exit.isSuccess(exit)) return "succeeded";
	// A refusal as the user reads it; anything else as it is.
	const error = Cause.squash(exit.cause);
	return Schema.is(Refusal)(error) ? refusal(error) : String(error);
};
const entries = () => desk((d) => d.entries);
const ask = (title: string, extra: Partial<Question> = {}) =>
	desk((d) => d.ask({ session: S("ses_a"), directory: "/w" }, { title, body: "", ...extra }));
const bytes = (text: string) => new TextEncoder().encode(text);
/** Whether the store has the attachment `file` (its path below the store). */
const stored = (file: string) =>
	Effect.runPromise(
		Effect.provideContext(
			Storage.use((storage) => Effect.map(storage.attachment(file), Option.isSome)),
			services,
		),
	);

/**
 * Memory storage that records the path of every attachment a transaction stores, in `files`; the `failing`th one
 * (counting from 1) can't be stored.
 */
const recording = (files: Array<string>, failing?: number) => {
	let tries = 0;
	return Layer.effect(
		Storage,
		Effect.map(Storage, (storage) =>
			Storage.of({
				...storage,
				transact: (change) =>
					storage.transact((all, store) =>
						change(all, {
							...store,
							attach: (name, data) =>
								++tries === failing
									? Effect.die("disk full")
									: Effect.tap(store.attach(name, data), (file) => Effect.sync(() => files.push(file))),
						}),
					),
			}),
		),
	).pipe(Layer.provide(Storage.layerMemory()));
};

describe("the rules, on memory storage", () => {
	beforeEach(() => open());
	afterEach(() => close());

	test("an empty answer is refused, the user's and the agent's alike", async () => {
		const asked = await ask("Q");
		const empty = (id: string) => `Entry ${id}: the text is empty.`;
		for (const text of ["", "  \n\t"])
			expect(await failure((d) => d.reply([{ entry: asked.id, text }], "queue"))).toBe(empty(asked.id));
		await desk((d) => d.reply([{ entry: asked.id, text: "yes" }], "queue"));
		// Answered: the user's next text there is a question of their own, which the agent answers.
		await desk((d) => d.reply([{ entry: asked.id, text: "and then?" }], "queue"));
		const theirs = present((await entries()).find((entry) => entry.parent === asked.id));
		for (const body of ["", "   "]) expect(await failure((d) => d.answer(theirs.id, body))).toBe(empty(theirs.id));
		expect((await entries()).map((entry) => [entry.id, entry.answer])).toEqual([
			[asked.id, "yes"],
			[theirs.id, null],
		]);
	});

	test("pruning walks up the parent chain", async () => {
		const root_ = await ask("Root");
		const child = await ask("Child", { parent: root_.id });
		const grandchild = await ask("Grandchild", { parent: child.id });
		await desk((d) => d.resolve(grandchild.id, "agent"));
		expect((await entries()).map((entry) => entry.id).sort()).toEqual([root_.id, child.id].sort());
		await desk((d) => d.resolve(child.id, "agent"));
		await desk((d) => d.resolve(root_.id, "agent"));
		expect(await entries()).toEqual([]);
	});

	test("adopt files a top-level entry once, never into its own subtree", async () => {
		const a = await ask("A");
		const b = await ask("B");
		const child = await ask("Child", { parent: a.id });
		expect(await failure((d) => d.adopt(a.id, child.id))).toContain("would make a cycle");
		expect((await desk((d) => d.adopt(b.id, a.id))).parent).toBe(a.id);
		expect(await failure((d) => d.adopt(b.id, child.id))).toContain("a parent never changes");
	});

	test("follow-ups inherit their parent's priority unless given one; prioritize can take a whole subtree", async () => {
		const top = await ask("Top", { priority: "high" });
		const inherited = await ask("Inherited", { parent: top.id });
		const own = await ask("Own", { parent: top.id, priority: "low" });
		expect([inherited.priority, own.priority]).toEqual(["high", "low"]);
		await desk((d) => d.prioritize(top.id, "critical", true));
		expect((await entries()).map((entry) => entry.priority)).toEqual(["critical", "critical", "critical"]);
		await desk((d) => d.prioritize(own.id, "normal", false));
		expect((await desk((d) => d.describe(undefined, S("ses_a")))).split("\n")[0]).toContain("Inherited");
	});

	test("describe: unresolved entries of the session's desk, flat with full ids, or one thread", async () => {
		const first = await ask("Root", { body: "Details" });
		await Bun.sleep(2);
		const second = await ask("Child", { body: "More", parent: first.id });
		await desk((d) => d.ask({ session: S("ses_elsewhere"), directory: "/x" }, { title: "Elsewhere", body: "" }));
		expect(await desk((d) => d.describe(undefined, S("ses_a")))).toBe(
			`- ${second.id} Child [open, user's turn] under ${first.id}\n- ${first.id} Root [open, user's turn]`,
		);
		// One entry in full; what it hangs under, and its follow-ups, one line each (the agent has their bodies already).
		const child = await desk((d) => d.describe(second.id, S("ses_a")));
		expect(child).toContain(`Under: ${first.id} Root (open)`);
		expect(child).toContain(`# ${second.id} Child`);
		expect(child).toContain("More");
		expect(child).not.toContain("Details");
		const root = await desk((d) => d.describe(first.id, S("ses_a")));
		expect(root).toContain(`Follow-ups: ${second.id} Child (open)`);
		expect(root).not.toContain("More");
	});

	test("replies are all or nothing, and a refused one stores no attachments", async () => {
		await close();
		const files: Array<string> = [];
		await open(recording(files));
		const entry = await ask("A?");
		const local = crypto.randomUUID();
		const files_ = [{ id: local, name: "a.png", data: bytes("AAAA") }];
		const error = await failure((d) =>
			d.reply(
				[
					{ entry: entry.id, text: `![a](attachment:${local})`, files: files_ },
					{ entry: E("gone"), text: "x" },
				],
				"queue",
			),
		);
		expect(error).toContain("No desk entry gone");
		expect((await entries())[0]).toMatchObject({ status: "open", pending: null });
		expect(files).toEqual([]);
		expect(
			await failure((d) => d.reply([{ entry: entry.id, text: `![b](attachment:${crypto.randomUUID()})` }], "queue")),
		).toContain("missing from the draft");
	});

	test("an attachment that can't be stored takes the ones stored before it with it", async () => {
		await close();
		// The second attachment fails to store.
		const files: Array<string> = [];
		await open(recording(files, 2));
		const entry = await ask("A?");
		const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
		const text = `![a](attachment:${a}) ![b](attachment:${b})`;
		const files_ = [
			{ id: a, name: "a.png", data: bytes("AAAA") },
			{ id: b, name: "b.png", data: bytes("AAAA") },
		];
		expect(await failure((d) => d.reply([{ entry: entry.id, text, files: files_ }], "queue"))).not.toBe("succeeded");
		expect(files).toHaveLength(1);
		expect(await stored(present(files[0]))).toBe(false);
		expect((await entries())[0]).toMatchObject({ status: "open", pending: null });
	});

	test("only referenced attachments are stored, and they go with the last entry pointing at them", async () => {
		await close();
		const files: Array<string> = [];
		await open(recording(files));
		const entry = await ask("A?");
		const [kept, dropped] = [crypto.randomUUID(), crypto.randomUUID()];
		await desk((d) =>
			d.reply(
				[
					{
						entry: entry.id,
						text: `![kept](attachment:${kept})`,
						files: [
							{ id: kept, name: "kept.png", data: bytes("AAAA") },
							{ id: dropped, name: "dropped.png", data: bytes("BBBB") },
						],
					},
				],
				"queue",
			),
		);
		expect(files).toHaveLength(1);
		const file = present(files[0]);
		expect(file).toMatch(/^attachments\/[0-9a-f-]{36}\.png$/);
		expect(await stored(file)).toBe(true);
		const answered = present((await entries())[0]);
		expect(answered.answer).toBe(`![kept](/${file})`);
		await desk((d) => d.delivered(present(answered.pending).message));
		await desk((d) => d.resolve(entry.id, "agent"));
		expect(await stored(file)).toBe(false);
	});

	test("a reply's entries share one pending message per session; delivered clears it", async () => {
		const a = await ask("A?");
		const b = await desk((d) => d.ask({ session: S("ses_b"), directory: "/w" }, { title: "B?", body: "" }));
		const c = await ask("C?");
		await desk((d) =>
			d.reply(
				[
					{ entry: a.id, text: "1" },
					{ entry: b.id, text: "2" },
					{ entry: c.id, text: "3" },
				],
				"queue",
			),
		);
		const byId = async (id: string) => present((await entries()).find((entry) => entry.id === id));
		const [ea, eb, ec] = [await byId(a.id), await byId(b.id), await byId(c.id)];
		expect(present(present(ea).pending).message).toBe(present(present(ec).pending).message);
		expect(present(present(eb).pending).message).not.toBe(present(present(ea).pending).message);
		await desk((d) => d.delivered(present(present(ea).pending).message));
		expect(
			[(await byId(a.id)).pending, (await byId(b.id)).pending, (await byId(c.id)).pending].map(
				(pending) => pending === null,
			),
		).toEqual([true, false, true]);
	});
});

describe("on a store on disk", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "desk-"));
		await open(onDisk(root));
	});
	afterEach(async () => {
		await close();
		await rm(root, { recursive: true, force: true });
	});

	test("entries are ordered by `created`, not by id, also after a restart; ids are never reused", async () => {
		const first = await ask("one");
		await Bun.sleep(2);
		await ask("two");
		await desk((d) => d.resolve(first.id, "agent"));
		await Bun.sleep(2);
		const third = await ask("three");
		expect(third.id).not.toBe(first.id);
		await close();
		await open(onDisk(root));
		expect((await entries()).map((entry) => entry.title)).toEqual(["two", "three"]);
	});

	test("the files are the state: a file put back to an earlier version is what the desk reads, and its rules apply to it", async () => {
		const asked = await ask("Kept?");
		const before = await readFile(join(root, `${asked.id}.md`), "utf8");
		await desk((d) => d.prioritize(asked.id, "high", false));
		expect(present((await entries())[0]).priority).toBe("high");
		// Restored by hand (git checkout, a sync tool) to the version the desk itself wrote first.
		await writeFile(join(root, `${asked.id}.md`), before);
		expect(present((await entries())[0]).priority).toBe("normal");
		await rm(join(root, `${asked.id}.md`));
		expect(await failure((d) => d.prioritize(asked.id, "low", false))).toContain(`No desk entry ${asked.id}`);
	});

	test("changes says when to read again: at the start, after the desk's own changes, and after edits by anyone", async () => {
		const signals: Array<number> = [];
		const fiber = Effect.runFork(
			Effect.provideContext(
				Desk.use((d) => d.changes.pipe(Stream.runForEach(() => Effect.sync(() => signals.push(Date.now()))))),
				services,
			),
		);
		await eventually(() => signals.length >= 1);
		const asked = await ask("Signalled?");
		await eventually(() => signals.length >= 2);
		const count = signals.length;
		await writeFile(
			join(root, `${asked.id}.md`),
			(await readFile(join(root, `${asked.id}.md`), "utf8")).replace("Signalled?", "Edited"),
		);
		await eventually(() => signals.length > count);
		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
