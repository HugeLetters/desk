/**
 * Fake OpenCode servers for the service's `Connect` seam, behaving as far as the desk relies on them: a server knows
 * its own sessions, admits a message id once (a repeat returns the first admission), can be down, and announces
 * sessions that move.
 */
import type { Connect, Endpoint, Prompt, SessionInfo } from "../../src/opencode";

export interface FakeServer {
	readonly url: string;
	readonly sessions: Map<string, SessionInfo>;
	/** Admitted prompts, in order; a repeated id is not admitted again. */
	readonly admitted: Array<Prompt>;
	/** Every prompt call, repeats included. */
	readonly calls: Array<Prompt>;
	down: boolean;
	/** The next prompt is admitted but the reply is lost (the caller sees an error). */
	loseNextReply: boolean;
	readonly endpoint: Endpoint;
	session(info: Partial<SessionInfo> & { id: string }): void;
	move(sessionID: string, projectID: string): void;
}

export function fakeOpenCode() {
	const servers = new Map<string, FakeServer>();
	const watchers = new Map<string, Set<(sessionID: string) => void>>();

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
			endpoint: { url },
			session(info) {
				this.sessions.set(info.id, { projectID: "prj_default", directory: "/work/default", ...info });
			},
			move(sessionID, projectID) {
				const session = this.sessions.get(sessionID)!;
				this.sessions.set(sessionID, { ...session, projectID });
				for (const notify of watchers.get(url) ?? []) notify(sessionID);
			},
		};
		servers.set(url, created);
		return created;
	};

	const connect: Connect = (endpoint) => {
		const fake = server(endpoint.url);
		return {
			session: async (sessionID) => {
				if (fake.down) throw new Error("connection refused");
				return fake.sessions.get(sessionID);
			},
			prompt: async (prompt) => {
				fake.calls.push(prompt);
				if (fake.down) throw new Error("connection refused");
				if (!fake.admitted.some((other) => other.id === prompt.id)) fake.admitted.push(prompt);
				if (fake.loseNextReply) {
					fake.loseNextReply = false;
					throw new Error("socket hang up");
				}
			},
			moves: (signal) => ({
				async *[Symbol.asyncIterator]() {
					const queue: Array<string> = [];
					let wake: (() => void) | undefined;
					const notify = (sessionID: string) => {
						queue.push(sessionID);
						wake?.();
					};
					const set = watchers.get(endpoint.url) ?? new Set();
					watchers.set(endpoint.url, set.add(notify));
					signal.addEventListener("abort", () => wake?.());
					try {
						while (!signal.aborted) {
							if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
							while (queue.length > 0) yield queue.shift()!;
						}
					} finally {
						set.delete(notify);
					}
				},
			}),
		};
	};

	return { connect, server };
}
