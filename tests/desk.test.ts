/** The desk's rules, through `Desk` on a temporary store. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Desk, type Question } from "../src/desk";
import { Store } from "../src/store";

let root: string;
let scope: Scope.Closeable;
let services: Context.Context<Desk>;

async function open() {
	scope = Effect.runSync(Scope.make());
	services = (await Effect.runPromise(Layer.buildWithScope(Desk.layer.pipe(Layer.provideMerge(Store.layer(root)), Layer.provideMerge(BunServices.layer)), scope))) as typeof services;
}
const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
const desk = <A, E>(f: (desk: Desk["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(Effect.provideContext(Desk.use(f), services));
const failure = async <A, E>(f: (desk: Desk["Service"]) => Effect.Effect<A, E>) => {
	const exit = await Effect.runPromiseExit(Effect.provideContext(Desk.use(f), services));
	return Exit.isFailure(exit) ? String(exit.cause) : "succeeded";
};
const entries = () => desk((d) => d.entries);
const ask = (title: string, extra: Partial<Question> = {}) => desk((d) => d.ask({ session: "ses_a", directory: "/w" }, { title, body: "", ...extra }));
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
	await desk((d) => d.ask({ session: "ses_elsewhere", directory: "/x" }, { title: "Elsewhere", body: "" }));
	expect(await desk((d) => d.describe(undefined, (entry) => entry.session === "ses_a"))).toBe(
		`- ${second.id} Child (follow-up to ${first.id}) — open, waiting on the user, asked by the agent\n- ${first.id} Root — open, blocked by its unresolved follow-ups, asked by the agent`,
	);
	const thread = await desk((d) => d.describe(second.id, () => true));
	expect(thread.indexOf(`# ${first.id} Root`)).toBeLessThan(thread.indexOf(`# ${second.id} Child`));
});

test("replies are all or nothing, and a refused one stores no attachments", async () => {
	const entry = await ask("A?");
	const local = crypto.randomUUID();
	const files_ = [{ id: local, name: "a.png", data: "AAAA" }];
	const error = await failure((d) =>
		d.reply(
			[
				{ entry: entry.id, text: `![a](attachment:${local})`, files: files_ },
				{ entry: "gone", text: "x" },
			],
			"queue",
		),
	);
	expect(error).toContain("No desk entry gone");
	expect((await entries())[0]).toMatchObject({ status: "open", outbox: null });
	expect(await attachments()).toEqual([]);
	expect(await failure((d) => d.reply([{ entry: entry.id, text: `![b](attachment:${crypto.randomUUID()})` }], "queue"))).toContain("missing from the draft");
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
						{ id: kept, name: "kept.png", data: "AAAA" },
						{ id: dropped, name: "dropped.png", data: "BBBB" },
					],
				},
			],
			"queue",
		),
	);
	const [stored] = await attachments();
	expect(stored).toMatch(/^[0-9a-f-]{36}\.png$/);
	const answered = (await entries())[0]!;
	expect(answered.answer).toBe(`![kept](/attachments/${stored})`);
	await desk((d) => d.delivered(answered.outbox!));
	await desk((d) => d.resolve(entry.id, "agent"));
	expect(await attachments()).toEqual([]);
});

test("a reply's entries share one outbox per session; delivered empties it", async () => {
	const a = await ask("A?");
	const b = await desk((d) => d.ask({ session: "ses_b", directory: "/w" }, { title: "B?", body: "" }));
	const c = await ask("C?");
	await desk((d) => d.reply([{ entry: a.id, text: "1" }, { entry: b.id, text: "2" }, { entry: c.id, text: "3" }], "queue"));
	const [ea, eb, ec] = await entries();
	expect(ea!.outbox).toBe(ec!.outbox);
	expect(eb!.outbox).not.toBe(ea!.outbox);
	await desk((d) => d.delivered(ea!.outbox!));
	expect((await entries()).map((entry) => entry.outbox === null)).toEqual([true, false, true]);
});
