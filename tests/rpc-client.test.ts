/** The TUI's plugin RPC client (`src/tui/rpc-client.ts`), over a fake of the TUI's OpenCode client. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BadgeRpc, Status } from "../src/plugin/badge-rpc";
import { rpcClient } from "../src/tui/rpc-client";
import { S } from "./support/ids";

const badge: Status = { page: new URL("http://127.0.0.1:1/sessions/ses_a"), waiting: 1, critical: 0 };
/** `badge` as it comes over the plugin RPC: encoded. */
const wire = Schema.encodeSync(Status)(badge);
const input = { session: S("ses_a") };

/** The TUI client's `rpc`, answering `status` with `answers` in turn and emitting `changed` to its listeners. */
const fakeClient = (answers: Array<() => Promise<unknown>>) => {
	const listeners: Array<(event: unknown) => void> = [];
	const calls: Array<{ input: unknown; location: unknown }> = [];
	const rpc = () => ({
		status: (input: unknown, options: { location?: unknown }) => {
			calls.push({ input, location: options.location });
			const answer = answers.shift();
			return answer ? answer() : Promise.reject(new Error("no answer"));
		},
		events: {
			on: (_name: string, listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => void listeners.splice(listeners.indexOf(listener), 1);
			},
		},
	});
	const context = { client: { rpc }, location: { directory: "/work/here" } } as never;
	const emit = (event: unknown) => {
		for (const listener of listeners) listener(event);
	};
	return { context, calls, emit };
};

test("a call decodes its output, at the TUI's location unless told another; rpc.unavailable is tried once more", async () => {
	const unavailable = { type: "rpc.unavailable", message: "not yet" };
	const fake = fakeClient([() => Promise.reject(unavailable), () => Promise.resolve(wire)]);
	const client = rpcClient(BadgeRpc, fake.context);
	expect(await Effect.runPromise(client.status(input))).toEqual(badge);
	expect(fake.calls).toEqual([
		{ input, location: { directory: "/work/here" } },
		{ input, location: { directory: "/work/here" } },
	]);

	const elsewhere = fakeClient([() => Promise.resolve(null)]);
	const there = rpcClient(BadgeRpc, elsewhere.context);
	expect(await Effect.runPromise(there.status(input, { location: { directory: "/work/there" } }))).toBeNull();
	expect(elsewhere.calls[0]?.location).toEqual({ directory: "/work/there" });
});

test("a call that fails on the way fails, not retried unless unavailable; output that doesn't fit fails too", async () => {
	const fake = fakeClient([() => Promise.reject(new Error("socket closed")), () => Promise.resolve(wire)]);
	const client = rpcClient(BadgeRpc, fake.context);
	const failed = await Effect.runPromise(Effect.flip(client.status(input)));
	expect(failed._tag).toBe("UnknownError");
	expect(fake.calls).toHaveLength(1);

	const bad = rpcClient(BadgeRpc, fakeClient([() => Promise.resolve({ page: 1 })]).context);
	expect((await Effect.runPromise(Effect.flip(bad.status(input))))._tag).toBe("SchemaError");
});

test("an event is a stream of its payloads, their data decoded; one that doesn't fit fails it", async () => {
	const fake = fakeClient([]);
	const client = rpcClient(BadgeRpc, fake.context);
	const received = Effect.runPromise(Stream.runCollect(Stream.take(client.events("changed"), 2)));
	await Bun.sleep(10);
	fake.emit({ type: "rpc.desk.changed", location: { directory: "/work/a" }, data: {} });
	fake.emit({ type: "rpc.desk.changed", location: { directory: "/work/b" }, data: {} });
	expect(Array.from(await received).map((event) => [event.location.directory, event.data])).toEqual([
		["/work/a", {}],
		["/work/b", {}],
	]);

	const failing = Effect.runPromise(Effect.flip(Stream.runDrain(client.events("changed"))));
	await Bun.sleep(10);
	fake.emit({ type: "rpc.desk.changed", location: { directory: "/work/a" }, data: null });
	expect((await failing)._tag).toBe("SchemaError");
});
