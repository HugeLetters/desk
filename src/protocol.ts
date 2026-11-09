/**
 * Plugin ↔ service, over the service's Unix socket: newline-delimited JSON, both ways.
 *
 * - The plugin's requests (`methods`): it sends `{ id, method, input }`; the service answers each with
 *   `{ id, output }` or `{ id, error }`. A plugin instance's first request on a connection is `hello`; it holds the
 *   connection for as long as it's loaded.
 * - The service's calls (`calls`), which the plugin makes in its own OpenCode for the service, so the service needs
 *   no endpoint or password of its own: the service sends `{ call, method, input }`; the plugin answers each with
 *   `{ call, output }` or `{ call, error }`.
 *
 * Each side decodes what it receives with these schemas (`decode`), so a malformed message is refused with a message
 * saying what's wrong, rather than misbehaving further in.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Delivery, Priority } from "./entry";

const method = <I extends Schema.Top, O extends Schema.Top>(input: I, output: O) => ({ input, output });

export const methods = {
	/** Who's connecting: the protocol it speaks, and its location's project (for the project's name). */
	hello: method(
		Schema.Struct({ protocol: Schema.String, project: Schema.optional(Schema.Struct({ id: Schema.String, directory: Schema.String })) }),
		Schema.Struct({ url: Schema.String }),
	),
	ask: method(
		Schema.Struct({
			asker: Schema.Struct({ session: Schema.String, directory: Schema.String }),
			question: Schema.Struct({
				title: Schema.String,
				body: Schema.String,
				labels: Schema.optional(Schema.Array(Schema.String)),
				parent: Schema.optional(Schema.String),
				priority: Schema.optional(Priority),
			}),
		}),
		Schema.Struct({ id: Schema.String, parent: Schema.NullOr(Schema.String), url: Schema.String }),
	),
	adopt: method(Schema.Struct({ id: Schema.String, parent: Schema.String }), Schema.Null),
	answer: method(Schema.Struct({ id: Schema.String, body: Schema.String }), Schema.Null),
	resolve: method(Schema.Struct({ id: Schema.String }), Schema.Null),
	prioritize: method(Schema.Struct({ id: Schema.String, priority: Priority, subtree: Schema.Boolean }), Schema.Null),
	/** The desk of `session`'s project, or one entry's thread. */
	list: method(Schema.Struct({ session: Schema.String, id: Schema.optional(Schema.String) }), Schema.String),
	/** The page for `session`'s project. */
	page: method(Schema.Struct({ session: Schema.String }), Schema.Struct({ url: Schema.String })),
	/** A session in this OpenCode moved to another directory (perhaps another project). */
	moved: method(Schema.Struct({ session: Schema.String }), Schema.Null),
};

export const SessionInfo = Schema.Struct({ id: Schema.String, parentID: Schema.optional(Schema.String), projectID: Schema.String, directory: Schema.String });
export type SessionInfo = typeof SessionInfo.Type;

export const Prompt = Schema.Struct({
	sessionID: Schema.String,
	/** The message id: OpenCode admits each id once, so a retry can't deliver twice. */
	id: Schema.String,
	text: Schema.String,
	delivery: Delivery,
	files: Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.String })),
});
export type Prompt = typeof Prompt.Type;

export const calls = {
	/** The session; null when this OpenCode doesn't know it. */
	session: method(Schema.Struct({ sessionID: Schema.String }), Schema.NullOr(SessionInfo)),
	prompt: method(Prompt, Schema.Null),
};

type Contract<T extends Record<string, { input: Schema.Top; output: Schema.Top }>> = {
	[K in keyof T]: { input: T[K]["input"]["Type"]; output: T[K]["output"]["Type"] };
};
export type Methods = Contract<typeof methods>;
export type Calls = Contract<typeof calls>;

/**
 * Bump for a change of meaning the schemas can't see (a field that keeps its type but means something else).
 */
const revision = 3;

/**
 * This contract's version: `<revision>.<hash of the schemas>`, so any change of shape changes it by itself. Plugin and
 * service compare it on `hello`. A hash can't say which side is older; the service decides (`socket.ts`).
 */
export const protocol = `${revision}.${Bun.hash(
	JSON.stringify(
		[methods, calls].map((contract) =>
			Object.entries(contract).map(([name, { input, output }]) => [name, Schema.toJsonSchemaDocument(input), Schema.toJsonSchemaDocument(output)]),
		),
	),
).toString(36)}`;

/** The files the contract is defined in: the service is outdated once they change after it started. */
export const contractFiles = [new URL("./protocol.ts", import.meta.url).pathname, new URL("./entry.ts", import.meta.url).pathname];

/**
 * Decodes what arrived for `method`: its `input` (as received) or its `output` (as answered). Fails with a message
 * naming the method and what's wrong.
 */
export const decode = <T extends Record<string, { input: Schema.Top; output: Schema.Top }>, K extends keyof T & string, P extends "input" | "output">(
	contract: T,
	name: K,
	part: P,
	value: unknown,
): Effect.Effect<T[K][P]["Type"], { readonly message: string }> => {
	const schema = contract[name]?.[part] as Schema.Codec<unknown, unknown> | undefined;
	if (!schema) return Effect.fail({ message: `Unknown method ${name}.` });
	return Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((issue) => ({ message: `${name}: ${part} doesn't match the desk protocol: ${issue.message}` }))) as never;
};

export type Method = keyof Methods;
export type Request<M extends Method = Method> = { readonly id: number; readonly method: M; readonly input: Methods[M]["input"] };
export type Response = { readonly id: number; readonly output: unknown } | { readonly id: number; readonly error: string };

export type CallMethod = keyof Calls;
export type Call<C extends CallMethod = CallMethod> = { readonly call: number; readonly method: C; readonly input: Calls[C]["input"] };
export type CallResult = { readonly call: number; readonly output: unknown } | { readonly call: number; readonly error: string };

export type { Delivery, Priority };
