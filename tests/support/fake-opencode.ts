/**
 * Fake OpenCode instances, behaving as far as the desk relies on them: one knows its own sessions, admits a message
 * id once (a repeat returns the first admission), can be down, and announces sessions that move. A test plugin
 * instance of one answers the service's calls from it (`serve`) and reports its moves (`watch`), as the plugin does
 * in its OpenCode.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Prompt, SessionInfo } from "../../src/api/protocol";
import type { SessionID } from "../../src/model/entry";
import type { Options } from "../../src/plugin/connection";
import { present } from "./present";

/** What the fake OpenCode fails with: down, refusing, or losing a reply; `message` is what the plugin passes on. */
class FakeFailure extends Data.TaggedError("FakeFailure")<{ readonly message: string }> {}

export interface FakeServer {
	/** Names the instance. */
	readonly url: string;
	readonly sessions: Map<SessionID, SessionInfo>;
	/** Admitted prompts, in order; a repeated id is not admitted again. */
	readonly admitted: Array<Prompt>;
	/** Every prompt call, repeats included. */
	readonly calls: Array<Prompt>;
	down: boolean;
	/** The next prompt is admitted but the reply is lost (the caller sees an error). */
	loseNextReply: boolean;
	/** Prompts are refused with this message, while set. */
	refuse: string | undefined;
	session(info: Partial<SessionInfo> & { id: SessionID }): void;
	/** The session moves to another folder, and the plugin reports it. */
	move(sessionID: SessionID, directory: string): void;
}

export function fakeOpenCode() {
	const servers = new Map<string, FakeServer>();
	const watchers = new Map<string, Set<(sessionID: SessionID) => void>>();

	const server = (url: string): FakeServer => {
		const existing = servers.get(url);
		if (existing) return existing;
		const created: FakeServer = {
			url,
			sessions: new Map(),
			admitted: [],
			calls: [],
			down: false,
			loseNextReply: false,
			refuse: undefined,
			session(info) {
				this.sessions.set(info.id, { title: "", directory: "/work/default", ...info });
			},
			move(sessionID, directory) {
				const session = present(this.sessions.get(sessionID));
				this.sessions.set(sessionID, { ...session, directory });
				for (const notify of watchers.get(url) ?? []) notify(sessionID);
			},
		};
		servers.set(url, created);
		return created;
	};

	/** What a plugin instance in `fake` answers the service's calls with. */
	const serve = (fake: FakeServer): Options["serve"] => ({
		session: (sessionID) =>
			Effect.suspend(() =>
				fake.down
					? Effect.fail(new FakeFailure({ message: "connection refused" }))
					: Effect.succeed(fake.sessions.get(sessionID) ?? null),
			),
		prompt: (prompt) =>
			Effect.suspend(() => {
				fake.calls.push(prompt);
				if (fake.down) return Effect.fail(new FakeFailure({ message: "connection refused" }));
				if (fake.refuse !== undefined) return Effect.fail(new FakeFailure({ message: fake.refuse }));
				if (!fake.admitted.some((other) => other.id === prompt.id)) fake.admitted.push(prompt);
				if (fake.loseNextReply) {
					fake.loseNextReply = false;
					return Effect.fail(new FakeFailure({ message: "socket hang up" }));
				}
				return Effect.void;
			}),
	});

	/** Calls `moved` for each session that moves in `fake`, until the returned function is called. */
	const watch = (fake: FakeServer, moved: (sessionID: SessionID) => void) => {
		const set = watchers.get(fake.url) ?? new Set();
		watchers.set(fake.url, set.add(moved));
		return () => set.delete(moved);
	};

	return { server, serve, watch };
}
