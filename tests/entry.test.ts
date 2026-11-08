import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { descendants, type Entry, fileName, idOf, next, openBelow, openUnder, ordered, parse, serialize, shortId, waitingFor, waitingOn } from "../src/entry";

const id = "5c0f9a1e-2b3d-4e5f-8a9b-0c1d2e00a7a7";
const parent = "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d003333";
const entry: Entry = {
	id,
	parent,
	asker: "agent",
	status: "answered",
	session: "ses_1",
	directory: "/work/phantom",
	labels: ["design", "icons"],
	priority: "normal",
	created: "2026-11-07T16:30:00.000Z",
	title: "Which icon?",
	question: "Pick one:\n\n![a](design/a.png)\n\n## Options\n\n- a\n- b",
	answer: "The angular one.",
	outbox: null,
	delivery: null,
};

test("an entry round-trips through its file", () => {
	expect(parse(id, serialize(entry))).toEqual(Option.some(entry));
	const open = { ...entry, parent: null, status: "open" as const, answer: null, labels: [] };
	expect(parse(id, serialize(open))).toEqual(Option.some(open));
});

test("the file has a YAML header; the id is the file name", () => {
	expect(serialize(entry)).toStartWith(
		`---\nparent: ${parent}\nasker: agent\nstatus: answered\nsession: ses_1\ndirectory: "/work/phantom"\nlabels: [design, icons]\ncreated: "2026-11-07T16:30:00.000Z"\n---\n\n# Which icon?\n`,
	);
	expect(fileName(id)).toBe(`${id}.md`);
	expect([idOf(`${id}.md`), idOf("0007.md"), idOf("QUESTIONS.md"), idOf(`${id}-x.md`)]).toEqual([id, undefined, undefined, undefined]);
	expect(shortId(id)).toBe("00a7a7");
});

test("an undelivered reply keeps its outbox and delivery in the header", () => {
	const pending = { ...entry, outbox: "msg_01JX", delivery: "steer" as const };
	expect(serialize(pending)).toContain(`created: "2026-11-07T16:30:00.000Z"\noutbox: msg_01JX\ndelivery: steer\n---`);
	expect(parse(id, serialize(pending))).toEqual(Option.some(pending));
});

test("files that aren't entries parse to None", () => {
	expect(parse(id, "# Notes\n\nfree-form")).toEqual(Option.none());
	expect(parse(id, "---\nasker: someone\n---\n\n# t")).toEqual(Option.none());
});

test("whose move it is", () => {
	expect(waitingOn({ ...entry, status: "open" }, [])).toBe("user");
	expect(waitingOn({ ...entry, status: "answered" }, [])).toBe("agent");
	expect(waitingOn({ ...entry, asker: "user", status: "open" }, [])).toBe("agent");
	expect(waitingOn({ ...entry, status: "resolved" }, [])).toBe(null);
});

test("blocked: an entry with an unresolved follow-up waits on nobody itself and is in neither group; its follow-up is", () => {
	const parent: Entry = { ...entry, id: "parent", parent: null, created: "1" }; // answered: would wait on the agent
	const followUp: Entry = { ...entry, id: "follow-up", parent: "parent", created: "2", status: "open", answer: null }; // waits on the user
	const deeper: Entry = { ...followUp, id: "deeper", parent: "follow-up", created: "3", status: "resolved" };
	const all = [parent, followUp, deeper];
	expect(waitingOn(parent, all)).toBe("blocked");
	expect(waitingOn(followUp, all)).toBe("user"); // a resolved entry below doesn't block
	expect(waitingFor(all, "user").map((e) => e.id)).toEqual(["follow-up"]);
	expect(waitingFor(all, "agent")).toEqual([]);
	expect(next(all, followUp)).toBeUndefined(); // Next skips the blocked parent
	// The follow-up resolved: the parent is back in its group.
	const done = [parent, { ...followUp, status: "resolved" as const }, deeper];
	expect(waitingOn(parent, done)).toBe("agent");
	expect(waitingFor(done, "agent").map((e) => e.id)).toEqual(["parent"]);
	expect(waitingFor(done, "user")).toEqual([]);
	// A resolved entry stays resolved, whatever is below it.
	expect(waitingOn({ ...parent, status: "resolved" }, all)).toBe(null);
});

test("Next: the next entry waiting on the user by `created`, wrapping round; none left means back to the list", () => {
	const at = (id: string, created: string, status: Entry["status"] = "open") => ({ ...entry, id, created, status, parent: null });
	const [a, b, c] = [at("a", "1"), at("b", "2"), at("c", "3", "answered")]; // c waits on the agents
	expect(next([a, b, c], a)?.id).toBe("b");
	expect(next([a, b, c], b)?.id).toBe("a"); // wraps round
	expect(next([a, b, c], { id: "gone", parent: null, created: "1.5", priority: "normal" })?.id).toBe("b"); // the current entry already left the desk
	expect(next([a, c], a)).toBeUndefined(); // nothing else waits on the user
	expect(next([c], { id: "gone", parent: null, created: "9", priority: "normal" })).toBeUndefined();
});

test("Open further down: entries below the direct children that wait on the user, in the desk's order", () => {
	const e = (id: string, parent: string | null, created: string, status: Entry["status"] = "open", asker: Entry["asker"] = "agent"): Entry => ({
		...entry,
		id,
		parent,
		created,
		status,
		asker,
		answer: null,
	});
	const entries = [
		e("root", null, "1"),
		e("child", "root", "2"), // a direct child: the Follow-ups list shows it
		e("deep2", "child", "6"),
		e("deep1", "child", "3"), // blocked by grand
		e("grand", "deep1", "4", "answered"), // blocked by deepest
		e("deepest", "grand", "5", "answered", "user"), // waits on the user, four levels down
		e("done", "child", "7", "resolved"),
		e("other", null, "0"),
		e("elsewhere", "other", "1"),
		e("elsewhere2", "elsewhere", "1"),
	];
	expect(openBelow(entries, { id: "root" }).map((x) => x.id)).toEqual(["deepest", "deep2"]);
	expect(openBelow(entries, { id: "deepest" })).toEqual([]);
	expect(openBelow(entries, { id: "elsewhere" }).map((x) => x.id)).toEqual([]);
	// openUnder counts everything unresolved at any depth, whoever it waits on
	expect(openUnder(entries, { id: "root" }).map((x) => x.id)).toEqual(["deepest", "grand", "deep1", "deep2", "child"]);
	expect(openUnder(entries, { id: "deepest" })).toEqual([]);
	expect(openUnder(entries, { id: "deep1" }).map((x) => x.id)).toEqual(["deepest", "grand"]);
	expect(descendants(entries, { id: "root" }).length).toBe(6); // resolved ones too
});

test("priority: absent means normal; only critical, high and low are written", () => {
	expect(serialize(entry)).not.toContain("priority");
	expect(parse(id, serialize(entry))).toEqual(Option.some(entry));
	for (const priority of ["critical", "high", "low"] as const) {
		const text = serialize({ ...entry, priority });
		expect(text).toContain(`\npriority: ${priority}\n`);
		expect(parse(id, text)).toEqual(Option.some({ ...entry, priority }));
	}
});

test("order: critical > high > normal > low, then `created`", () => {
	const at = (id: string, created: string, priority: Entry["priority"]) => ({ ...entry, id, created, priority, parent: null, status: "open" as const });
	const all = [at("low", "0", "low"), at("normal", "1", "normal"), at("high", "2", "high"), at("late-critical", "9", "critical"), at("critical", "3", "critical")];
	expect(ordered(all).map((e) => e.id)).toEqual(["critical", "late-critical", "high", "normal", "low"]);
	expect(next(all, all[4]!)?.id).toBe("late-critical");
	expect(next(all, all[3]!)?.id).toBe("high");
});

test("order and Next: priority first, then `created`", () => {
	const at = (id: string, created: string, priority: Entry["priority"]) => ({ ...entry, id, created, priority, parent: null, status: "open" as const });
	const [late, early, low, high] = [at("late-high", "9", "high"), at("early", "1", "normal"), at("low", "0", "low"), at("high", "5", "high")];
	expect(ordered([low, early, late, high]).map((e) => e.id)).toEqual(["high", "late-high", "early", "low"]);
	expect(next([low, early, late, high], high)?.id).toBe("late-high");
	expect(next([low, early, late, high], low)?.id).toBe("high"); // wraps round to the top
	expect(next([low, early, late, high], { id: "gone", parent: null, created: "6", priority: "high" })?.id).toBe("late-high");
});

test("order and Next: within a priority, follow-ups before the entries they hang under", () => {
	const at = (id: string, parent: string | null, created: string, priority: Entry["priority"] = "normal") => ({ ...entry, id, parent, created, priority, status: "open" as const });
	const review = at("review", null, "1");
	const [first, second] = [at("first", "review", "2"), at("second", "review", "3")];
	const deeper = at("deeper", "first", "4");
	const [older, urgent] = [at("older", null, "0"), at("urgent", null, "5", "high")];
	const all = [review, second, deeper, first, older, urgent];
	expect(ordered(all).map((e) => e.id)).toEqual(["urgent", "older", "deeper", "first", "second", "review"]);
	// A raised follow-up still goes first; a lowered one moves below its parent with its priority.
	expect(ordered([review, { ...second, priority: "high" }, { ...first, priority: "low" }]).map((e) => e.id)).toEqual(["second", "review", "first"]);
	// Blocked entries (first under deeper, review under both) wait on nobody, so Next skips them.
	expect(next(all, deeper)?.id).toBe("second");
	expect(next(all, second)?.id).toBe("urgent"); // wraps round
	expect(next([review, { ...first, status: "resolved" as const }], first)?.id).toBe("review"); // its follow-up done: the review waits again
	// The current entry left the desk (a follow-up, answered and pruned): Next goes on from where it was.
	expect(next([review, older], { id: "gone", parent: "review", created: "9", priority: "normal" })?.id).toBe("review");
});
