/**
 * The desk's rules as properties, over generated desks and generated sequences of changes, against small reference
 * models: what `entry.ts` derives (order, whose turn, Next) and what `Desk` keeps true whatever happens (no orphans,
 * no cycles, a refused change leaves the files as they were).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arbitrary from "effect/Arbitrary";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Desk } from "../src/desk";
import { answerer, type Entry, next, ordered, Party, Priority, Status, waitingOn } from "../src/entry";
import { Store } from "../src/store";
import { E, S } from "./support/ids";

const runs = Number(process.env.PROPERTY_RUNS ?? 200);

/** Runs a property; a counterexample fails the test with the shrunk input and how to replay it. */
const check = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => boolean | Effect.Effect<boolean, unknown>) => {
	const result = await Effect.runPromise(Arbitrary.checkEffect(arbitrary, property, { runs }));
	expect(Arbitrary.formatCheckFailure(result) ?? "passed").toBe("passed");
};

const pick = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })));

/** A desk: entry i hangs under an earlier one or none, so it's a forest, as the desk's rules keep it. */
const Shape = Schema.Struct({ root: Schema.Boolean, parent: Schema.Int, asker: Party, status: Status, priority: Priority });
const desks = Arbitrary.array(
	Arbitrary.map(Arbitrary.all({ root: Arbitrary.schema(Schema.Boolean), parent: pick, asker: Arbitrary.schema(Party), status: Arbitrary.schema(Status), priority: Arbitrary.schema(Priority) }), (shape) => shape as typeof Shape.Type),
	{ maxLength: 12 },
).pipe(
	Arbitrary.map((shapes): Array<Entry> =>
		shapes.map((shape, index) => ({
			id: E(`e${index}`),
			parent: index === 0 || shape.root ? null : E(`e${shape.parent % index}`),
			asker: shape.asker,
			status: shape.status,
			session: S("ses_a"),
			directory: "/w",
			labels: [],
			priority: shape.priority,
			created: String(index).padStart(4, "0"),
			title: `e${index}`,
			question: "",
			answer: shape.status === "open" ? null : "a",
			pending: null,
		})),
	),
);

// The reference model: the definitions, written the plain way.
const below = (all: ReadonlyArray<Entry>, entry: Entry): Array<Entry> => all.filter((other) => other.parent === entry.id).flatMap((child) => [child, ...below(all, child)]);
const turn = (all: ReadonlyArray<Entry>, entry: Entry) =>
	entry.status === "resolved" ? null : below(all, entry).some((other) => other.status !== "resolved") ? "blocked" : entry.status === "open" ? answerer(entry) : entry.asker;
const rank = (entry: Entry) => Priority.literals.indexOf(entry.priority);

test("whose turn it is: nobody once resolved, blocked by anything unresolved below, else the answerer or the asker", () =>
	check(desks, (all) => all.every((entry) => waitingOn(entry, all) === turn(all, entry))));

test("the order: every entry once, priority first, and within a priority an entry after everything below it", () =>
	check(desks, (all) => {
		const order = ordered(all);
		const at = (entry: Entry) => order.indexOf(entry);
		return (
			order.length === all.length &&
			all.every((entry) => order.includes(entry)) &&
			order.every((entry, index) => index === 0 || rank(order[index - 1]!) <= rank(entry)) &&
			all.every((entry) => below(all, entry).every((other) => other.priority !== entry.priority || at(other) < at(entry)))
		);
	}));

test("Next: the first entry after this one in the order, wrapping round, that waits on the user; none when nothing else does", () =>
	check(Arbitrary.all([desks, pick]), ([all, choice]) => {
		if (all.length === 0) return true;
		const current = all[choice % all.length]!;
		const order = ordered(all);
		const at = order.indexOf(current);
		const after = [...order.slice(at + 1), ...order.slice(0, at)];
		return next(all, current) === after.find((entry) => turn(all, entry) === "user");
	}));

// The desk keeps its shape whatever the agents and the user do.
let root: string;
let scope: Scope.Closeable;
let services: Context.Context<Desk>;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "desk-properties-"));
	scope = Effect.runSync(Scope.make());
	services = (await Effect.runPromise(Layer.buildWithScope(Desk.layer.pipe(Layer.provideMerge(Store.layer(root)), Layer.provideMerge(BunServices.layer)), scope))) as typeof services;
});
afterAll(async () => {
	await Effect.runPromise(Scope.close(scope, Exit.void));
	await rm(root, { recursive: true, force: true });
});

const Change = Schema.Union([
	Schema.Struct({ do: Schema.Literal("ask"), parent: Schema.NullOr(Schema.Int) }),
	Schema.Struct({ do: Schema.Literal("adopt"), id: Schema.Int, parent: Schema.Int }),
	Schema.Struct({ do: Schema.Literal("answer"), id: Schema.Int }),
	Schema.Struct({ do: Schema.Literal("reply"), id: Schema.Int, also: Schema.NullOr(Schema.Int) }),
	Schema.Struct({ do: Schema.Literal("delivered"), id: Schema.Int }),
	Schema.Struct({ do: Schema.Literal("resolve"), id: Schema.Int, by: Party }),
]);
type Change = typeof Change.Type;
const changes = Arbitrary.array(
	Arbitrary.schema(Change).pipe(Arbitrary.map((change): Change => JSON.parse(JSON.stringify(change, (_, value) => (typeof value === "number" ? Math.abs(value) % 1000 : value))))),
	{ minLength: 10, maxLength: 40 },
);

/** The store's files, as text: what a refused change must leave as it was. */
const snapshot = async () => {
	const names = (await readdir(root)).filter((name) => name.endsWith(".md")).sort();
	return Promise.all(names.map(async (name) => `${name}\n${await readFile(join(root, name), "utf8")}`));
};

test("whatever happens, every entry's parent is on the desk, no entry is below itself, and a refused change writes nothing", () =>
	check(changes, (sequence) =>
		Effect.gen(function* () {
			const desk = yield* Desk;
			// A fresh desk for each sequence.
			for (const entry of yield* desk.entries) yield* Effect.promise(() => rm(join(root, `${entry.id}.md`)));
			for (const change of sequence) {
				const all = yield* desk.entries;
				const nth = (n: number) => all[n % Math.max(all.length, 1)];
				const before = yield* Effect.promise(snapshot);
				const result = yield* Effect.exit(
					Effect.gen(function* () {
						switch (change.do) {
							case "ask":
								return yield* desk.ask({ session: S("ses_a"), directory: "/w" }, { title: "q", body: "", parent: change.parent === null ? undefined : nth(change.parent)?.id });
							case "adopt":
								if (!nth(change.id) || !nth(change.parent)) return;
								return yield* desk.adopt(nth(change.id)!.id, nth(change.parent)!.id);
							case "answer":
								if (!nth(change.id)) return;
								return yield* desk.answer(nth(change.id)!.id, "an answer");
							case "reply": {
								if (!nth(change.id)) return;
								const also = change.also === null ? [] : [{ entry: nth(change.also)?.id ?? E(crypto.randomUUID()), text: "more" }];
								return yield* desk.reply([{ entry: nth(change.id)!.id, text: "a reply" }, ...also], "queue");
							}
							case "delivered": {
								const pending = nth(change.id)?.pending;
								if (pending) yield* desk.delivered(pending.message);
								return;
							}
							case "resolve":
								if (!nth(change.id)) return;
								return yield* desk.resolve(nth(change.id)!.id, change.by);
						}
					}),
				);
				if (Exit.isFailure(result) && (yield* Effect.promise(snapshot)).join("\0") !== before.join("\0")) return false;
				const now = yield* desk.entries;
				const ids = new Set(now.map((entry) => entry.id));
				if (now.some((entry) => entry.parent !== null && !ids.has(entry.parent))) return false;
				for (const entry of now) {
					const seen = new Set<string>();
					for (let at: Entry | undefined = entry; at; at = now.find((other) => other.id === at!.parent)) {
						if (seen.has(at.id)) return false;
						seen.add(at.id);
					}
				}
			}
			return true;
		}).pipe(Effect.provideContext(services)),
	), 60_000);
