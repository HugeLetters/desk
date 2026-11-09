import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { descendants, type Entry, fileName, idOf, next, openBelow, openUnder, ordered, parse, serialize, shortId, waitingFor, waitingOn } from "../src/entry";
import { E, S, M } from "./support/ids";

const id = E("5c0f9a1e-2b3d-4e5f-8a9b-0c1d2e00a7a7");
const parent = E("0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d003333");
const entry: Entry = {
	id,
	parent,
	asker: "agent",
	status: "answered",
	session: S("ses_1"),
	directory: "/work/phantom",
	labels: ["design", "icons"],
	priority: "normal",
	created: "2026-11-07T16:30:00.000Z",
	title: "Which icon?",
	question: "Pick one:\n\n![a](design/a.png)\n\n## Options\n\n- a\n- b",
	answer: "The angular one.",
	pending: null,
};

test("an entry round-trips through its file", () => {
	expect<unknown>(parse(id, serialize(entry))).toEqual(Option.some(entry));
	const open = { ...entry, parent: null, status: "open" as const, answer: null, labels: [] };
	expect<unknown>(parse(id, serialize(open))).toEqual(Option.some(open));
});

test("the file has a YAML header; the id is the file name", () => {
	expect<unknown>(serialize(entry)).toStartWith(
		`---\nparent: ${parent}\nasker: agent\nstatus: answered\nsession: ses_1\ndirectory: "/work/phantom"\nlabels: [design, icons]\ncreated: "2026-11-07T16:30:00.000Z"\n---\n\n# Which icon?\n`,
	);
	expect<unknown>(fileName(id)).toBe(`${id}.md`);
	expect<unknown>([idOf(`${id}.md`), idOf("0007.md"), idOf("QUESTIONS.md"), idOf(`${id}-x.md`)]).toEqual([id, undefined, undefined, undefined]);
	expect<unknown>(shortId(id)).toBe("00a7a7");
});

test("text still pending is in the header as its message (`outbox`) and delivery", () => {
	const pending = { ...entry, pending: { message: M("msg_01JX"), delivery: "steer" as const } };
	expect<unknown>(serialize(pending)).toContain(`created: "2026-11-07T16:30:00.000Z"\noutbox: msg_01JX\ndelivery: steer\n---`);
	expect<unknown>(parse(id, serialize(pending))).toEqual(Option.some(pending));
});

test("files that aren't entries parse to None", () => {
	expect<unknown>(parse(id, "# Notes\n\nfree-form")).toEqual(Option.none());
	expect<unknown>(parse(id, "---\nasker: someone\n---\n\n# t")).toEqual(Option.none());
});

test("whose move it is", () => {
	expect<unknown>(waitingOn({ ...entry, status: "open" })).toBe("user");
	expect<unknown>(waitingOn({ ...entry, status: "answered" })).toBe("agent");
	expect<unknown>(waitingOn({ ...entry, asker: "user", status: "open" })).toBe("agent");
	expect<unknown>(waitingOn({ ...entry, status: "resolved" })).toBe(null);
});

test("what's open below an entry doesn't change whose turn it is; the order puts it first", () => {
	const parent: Entry = { ...entry, id: E("parent"), parent: null, created: "1", status: "open", answer: null }; // an agent's question to the user
	const followUp: Entry = { ...entry, id: E("follow-up"), parent: E("parent"), created: "2", status: "open", answer: null };
	const all = [parent, followUp];
	expect<unknown>(waitingOn(parent)).toBe("user");
	expect<unknown>(waitingFor(all, "user").map((e) => e.id)).toEqual(["follow-up", "parent"]);
	expect<unknown>(next(all, followUp)?.id).toBe("parent");
});

test("Next: the next entry waiting on the user by `created`, wrapping round; none left means back to the list", () => {
	const at = (id: string, created: string, status: Entry["status"] = "open") => ({ ...entry, id: E(id), created, status, parent: null });
	const [a, b, c] = [at("a", "1"), at("b", "2"), at("c", "3", "answered")]; // c waits on the agents
	expect<unknown>(next([a, b, c], a)?.id).toBe("b");
	expect<unknown>(next([a, b, c], b)?.id).toBe("a"); // wraps round
	expect<unknown>(next([a, b, c], { id: E("gone"), parent: null, created: "1.5", priority: "normal" })?.id).toBe("b"); // the current entry already left the desk
	expect<unknown>(next([a, c], a)).toBeUndefined(); // nothing else waits on the user
	expect<unknown>(next([c], { id: E("gone"), parent: null, created: "9", priority: "normal" })).toBeUndefined();
});

test("Open further down: entries below the direct children that wait on the user, in the desk's order", () => {
	const e = (id: string, parent: string | null, created: string, status: Entry["status"] = "open", asker: Entry["asker"] = "agent"): Entry => ({
		...entry,
		id: E(id),
		parent: parent === null ? null : E(parent),
		created,
		status,
		asker,
		answer: null,
	});
	const entries = [
		e("root", null, "1"),
		e("child", "root", "2"), // a direct child: the Follow-ups list shows it
		e("deep2", "child", "6"),
		e("deep1", "child", "3"),
		e("grand", "deep1", "4", "answered"), // waits on the agent
		e("deepest", "grand", "5", "answered", "user"), // waits on the user, four levels down
		e("done", "child", "7", "resolved"),
		e("other", null, "0"),
		e("elsewhere", "other", "1"),
		e("elsewhere2", "elsewhere", "1"),
	];
	expect<unknown>(openBelow(entries, { id: E("root") }).map((x) => x.id)).toEqual(["deepest", "deep1", "deep2"]);
	expect<unknown>(openBelow(entries, { id: E("deepest") })).toEqual([]);
	expect<unknown>(openBelow(entries, { id: E("elsewhere") }).map((x) => x.id)).toEqual([]);
	// openUnder counts everything unresolved at any depth, whoever it waits on
	expect<unknown>(openUnder(entries, { id: E("root") }).map((x) => x.id)).toEqual(["deepest", "grand", "deep1", "deep2", "child"]);
	expect<unknown>(openUnder(entries, { id: E("deepest") })).toEqual([]);
	expect<unknown>(openUnder(entries, { id: E("deep1") }).map((x) => x.id)).toEqual(["deepest", "grand"]);
	expect<unknown>(descendants(entries, { id: E("root") }).length).toBe(6); // resolved ones too
});

test("priority: absent means normal; only critical, high and low are written", () => {
	expect<unknown>(serialize(entry)).not.toContain("priority");
	expect<unknown>(parse(id, serialize(entry))).toEqual(Option.some(entry));
	for (const priority of ["critical", "high", "low"] as const) {
		const text = serialize({ ...entry, priority });
		expect<unknown>(text).toContain(`\npriority: ${priority}\n`);
		expect<unknown>(parse(id, text)).toEqual(Option.some({ ...entry, priority }));
	}
});

test("order: critical > high > normal > low, then `created`", () => {
	const at = (id: string, created: string, priority: Entry["priority"]) => ({ ...entry, id: E(id), created, priority, parent: null, status: "open" as const });
	const all = [at("low", "0", "low"), at("normal", "1", "normal"), at("high", "2", "high"), at("late-critical", "9", "critical"), at("critical", "3", "critical")];
	expect<unknown>(ordered(all).map((e) => e.id)).toEqual(["critical", "late-critical", "high", "normal", "low"]);
	expect<unknown>(next(all, all[4]!)?.id).toBe("late-critical");
	expect<unknown>(next(all, all[3]!)?.id).toBe("high");
});

test("order and Next: priority first, then `created`", () => {
	const at = (id: string, created: string, priority: Entry["priority"]) => ({ ...entry, id: E(id), created, priority, parent: null, status: "open" as const });
	const [late, early, low, high] = [at("late-high", "9", "high"), at("early", "1", "normal"), at("low", "0", "low"), at("high", "5", "high")];
	expect<unknown>(ordered([low, early, late, high]).map((e) => e.id)).toEqual(["high", "late-high", "early", "low"]);
	expect<unknown>(next([low, early, late, high], high)?.id).toBe("late-high");
	expect<unknown>(next([low, early, late, high], low)?.id).toBe("high"); // wraps round to the top
	expect<unknown>(next([low, early, late, high], { id: E("gone"), parent: null, created: "6", priority: "high" })?.id).toBe("late-high");
});

test("order and Next: within a priority, follow-ups before the entries they hang under", () => {
	const at = (id: string, parent: string | null, created: string, priority: Entry["priority"] = "normal") => ({ ...entry, id: E(id), parent: parent === null ? null : E(parent), created, priority, status: "open" as const });
	const review = at("review", null, "1");
	const [first, second] = [at("first", "review", "2"), at("second", "review", "3")];
	const deeper = at("deeper", "first", "4");
	const [older, urgent] = [at("older", null, "0"), at("urgent", null, "5", "high")];
	const all = [review, second, deeper, first, older, urgent];
	expect<unknown>(ordered(all).map((e) => e.id)).toEqual(["urgent", "older", "deeper", "first", "second", "review"]);
	// A raised follow-up still goes first; a lowered one moves below its parent with its priority.
	expect<unknown>(ordered([review, { ...second, priority: "high" }, { ...first, priority: "low" }]).map((e) => e.id)).toEqual(["second", "review", "first"]);
	// Next goes through them in that order: a follow-up, then the entry it hangs under.
	expect<unknown>(next(all, deeper)?.id).toBe("first");
	expect<unknown>(next(all, review)?.id).toBe("urgent"); // wraps round
	expect<unknown>(next([review, { ...first, status: "resolved" as const }], first)?.id).toBe("review"); // its follow-up done: the review waits again
	// The current entry left the desk (a follow-up, answered and pruned): Next goes on from where it was.
	expect<unknown>(next([review, older], { id: E("gone"), parent: E("review"), created: "9", priority: "normal" })?.id).toBe("review");
});
