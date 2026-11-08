/**
 * Plugin ↔ service, over the service's Unix socket: newline-delimited JSON. The plugin sends
 * `{ id, method, input }`; the service answers each with `{ id, output }` or `{ id, error }`. A plugin instance's
 * first request on a connection is `hello`; it holds the connection for as long as it's loaded.
 *
 * Types only, so the plugin imports nothing at runtime from the service's side.
 */
import type { Delivery, Priority } from "./entry";

export interface Endpoint {
	readonly url: string;
	readonly password?: string | undefined;
}

export interface Methods {
	/** Who's connecting: its OpenCode server (so the service can reach its sessions) and its location's project. */
	hello: {
		input: { opencode?: Endpoint | undefined; project?: { id: string; directory: string } | undefined };
		output: { url: string };
	};
	ask: {
		input: {
			asker: { session: string; directory: string };
			question: { title: string; body: string; labels?: ReadonlyArray<string> | undefined; parent?: string | undefined; priority?: Priority | undefined };
		};
		output: { id: string; parent: string | null; url: string };
	};
	adopt: { input: { id: string; parent: string }; output: null };
	answer: { input: { id: string; body: string }; output: null };
	resolve: { input: { id: string }; output: null };
	prioritize: { input: { id: string; priority: Priority; subtree: boolean }; output: null };
	/** The desk of `session`'s project, or one entry's thread. */
	list: { input: { session: string; id?: string | undefined }; output: string };
	/** The page for `session`'s project. */
	page: { input: { session: string }; output: { url: string } };
}

export type Method = keyof Methods;
export type Request<M extends Method = Method> = { readonly id: number; readonly method: M; readonly input: Methods[M]["input"] };
export type Response = { readonly id: number; readonly output: unknown } | { readonly id: number; readonly error: string };

export type { Delivery, Priority };
