/** The desk's rules, through `Desk` on a temporary store. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Desk, type Question } from "../src/desk";
import { Refusal } from "../src/errors";
import { Store } from "../src/store";
import { refusal } from "../src/wording";
import { E, S } from "./support/ids";
import { present } from "./support/present";
import { eventually } from "./support/service";

let root: string;
let scope: Scope.Closeable;
let services: Context.Context<Desk>;

async function open() {
	scope = Effect.runSync(Scope.make());
	services = (await Effect.runPromise(
		Layer.buildWithScope(
			Desk.layer.pipe(Layer.provideMerge(Store.layer(root)), Layer.provideMerge(BunServices.layer)),
			scope,
		),
	)) as typeof services;
}
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
const files = async () => (await readdir(root)).filter((name) => name.endsWith(".md")).sort();
const attachments = async () => (await readdir(join(root, "attachments")).catch(() => [])).sort();

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "desk-"));
	await open();
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
	await open();
	expect((await entries()).map((entry) => entry.title)).toEqual(["two", "three"]);
});

test("pruning walks up the parent chain", async () => {
	const root_ = await ask("Root");
	const child = await ask("Child", { parent: root_.id });
	const grandchild = await ask("Grandchild", { parent: child.id });
	await desk((d) => d.resolve(grandchild.id, "agent"));
	expect(await files()).toEqual([`${root_.id}.md`, `${child.id}.md`].sort());
	await desk((d) => d.resolve(child.id, "agent"));
	await desk((d) => d.resolve(root_.id, "agent"));
	expect(await files()).toEqual([]);
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
	expect((await desk((d) => d.describe(undefined, () => true))).split("\n")[0]).toContain("Inherited");
});

test("describe: unresolved entries of the scope, flat with full ids, or one thread", async () => {
	const first = await ask("Root", { body: "Details" });
	await Bun.sleep(2);
	const second = await ask("Child", { body: "More", parent: first.id });
	await desk((d) => d.ask({ session: S("ses_elsewhere"), directory: "/x" }, { title: "Elsewhere", body: "" }));
	expect(await desk((d) => d.describe(undefined, (entry) => entry.session === "ses_a"))).toBe(
		`- ${second.id} Child [open, user's turn] under ${first.id}\n- ${first.id} Root [open, user's turn]`,
	);
	// One entry in full; what it hangs under, and its follow-ups, one line each (the agent has their bodies already).
	const child = await desk((d) => d.describe(second.id, () => true));
	expect(child).toContain(`Under: ${first.id} Root (open)`);
	expect(child).toContain(`# ${second.id} Child`);
	expect(child).toContain("More");
	expect(child).not.toContain("Details");
	const root = await desk((d) => d.describe(first.id, () => true));
	expect(root).toContain(`Follow-ups: ${second.id} Child (open)`);
	expect(root).not.toContain("More");
});

test("replies are all or nothing, and a refused one stores no attachments", async () => {
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
	expect(await attachments()).toEqual([]);
	expect(
		await failure((d) => d.reply([{ entry: entry.id, text: `![b](attachment:${crypto.randomUUID()})` }], "queue")),
	).toContain("missing from the draft");
});

test("an attachment that can't be stored takes the ones stored before it with it", async () => {
	const entry = await ask("A?");
	await close();
	// The same store, except that its second attachment fails to write.
	const failing = Layer.effect(
		Store,
		Effect.map(Store, (store) => {
			let stored = 0;
			return Store.of({
				...store,
				attach: (name, data) => (++stored === 2 ? Effect.die("disk full") : store.attach(name, data)),
			});
		}),
	).pipe(Layer.provide(Store.layer(root)));
	scope = Effect.runSync(Scope.make());
	services = (await Effect.runPromise(
		Layer.buildWithScope(Desk.layer.pipe(Layer.provideMerge(failing), Layer.provideMerge(BunServices.layer)), scope),
	)) as typeof services;
	const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
	const text = `![a](attachment:${a}) ![b](attachment:${b})`;
	const files_ = [
		{ id: a, name: "a.png", data: bytes("AAAA") },
		{ id: b, name: "b.png", data: bytes("AAAA") },
	];
	const exit = await Effect.runPromiseExit(
		Effect.provideContext(
			Desk.use((d) => d.reply([{ entry: entry.id, text, files: files_ }], "queue")),
			services,
		),
	);
	expect(Exit.isFailure(exit)).toBe(true);
	expect(await attachments()).toEqual([]);
	expect((await entries())[0]).toMatchObject({ status: "open", pending: null });
});

test("only referenced attachments are stored, and they go with the last entry pointing at them", async () => {
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
	const [stored] = await attachments();
	expect(stored).toMatch(/^[0-9a-f-]{36}\.png$/);
	const answered = present((await entries())[0]);
	expect(answered.answer).toBe(`![kept](/attachments/${stored})`);
	await desk((d) => d.delivered(present(answered.pending).message));
	await desk((d) => d.resolve(entry.id, "agent"));
	expect(await attachments()).toEqual([]);
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
