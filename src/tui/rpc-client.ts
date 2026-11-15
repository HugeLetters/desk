/**
 * A plugin RPC client for the TUI, from a definition with Effect schemas: each method encodes its input and decodes
 * its output (and its declared errors) with them, and each event is a `Stream` of its payloads, their data decoded.
 * OpenCode's TUI client takes portable schemas only, so they're converted for it (`toStandardSchemaV1`).
 */
import type { RpcCallOptions, RpcEventPayload } from "@opencode/client";
import type { Plugin } from "@opencode/plugin/tui";
import type { Rpc } from "@opencode/schema/rpc";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** An RPC client of `definition`, over the TUI's OpenCode client. */
export function rpcClient<D extends Rpc.Definition>(
	definition: D,
	context: Pick<Plugin.Context, "client" | "location">,
): RpcClient<D> {
	const portable = <S extends Rpc.Method["input"] | Rpc.EventDefinition["schema"]>(schema: S) =>
		Schema.isSchema(schema) ? Schema.toStandardSchemaV1(schema as Schema.Codec<unknown>) : schema;

	const transport = context.client.rpc({
		id: definition.id,
		methods: Object.fromEntries(
			Object.entries(definition.methods).map(([name, method]) => [
				name,
				{ input: portable(method.input), output: portable(method.output) } as Rpc.PortableMethod,
			]),
		),
		events: Object.fromEntries(
			Object.entries(definition.events).map(([name, event]) => [
				name,
				{ schema: portable(event.schema) } as Rpc.PortableEventDefinition,
			]),
		),
	});

	const methods = Object.fromEntries(
		Object.entries(definition.methods).map(([name, method]) => {
			const encodeInput = Schema.isSchema(method.input)
				? Schema.encodeEffect<Schema.Codec<unknown>>(method.input)
				: Effect.succeed;

			const decodeOutput = Schema.isSchema(method.output)
				? Schema.decodeUnknownEffect<Schema.Codec<unknown>>(method.output)
				: Effect.succeed;

			const decodeError = Effect.fnUntraced(function* (error: Cause.UnknownError) {
				const e = error.cause;
				if (method.errors !== undefined && isRpcError(e) && Object.hasOwn(method.errors, e.type)) {
					const schema = method.errors[e.type];
					const data = Schema.isSchema(schema) ? yield* Schema.decodeUnknownEffect(schema)(e.data) : e.data;
					return new Declared({ _tag: e.type, message: e.message, data });
				}

				return error;
			});

			// Values are `unknown` here because Object.entries erases each method's types; RpcMethod restores them for
			// callers.
			const call = Effect.fnUntraced(function* (input: unknown, options?: RpcCallOptions) {
				const encoded = yield* encodeInput(input);

				const output = yield* Effect.tryPromise((signal) => {
					const method = transport[name];
					if (method === undefined) throw new Error(`No RPC method ${name}`);

					return method(encoded, {
						...options,
						location: options?.location ?? context.location,
						signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
					});
				}).pipe(
					// The server can answer a call to a just-booted location before plugins register
					// their handlers: https://github.com/anomalyco/opencode/issues/63280
					// rpc.unavailable means the handler never ran, so one retry is safe.
					Effect.retry({ times: 1, schedule: Schedule.spaced(Duration.millis(500)), while: isUnavailable }),
					Effect.catch((e) => decodeError(e).pipe(Effect.flatMap(Effect.fail))),
				);

				return yield* decodeOutput(output);
			});

			return [name, call];
		}),
	);

	const events = (name: string) => {
		const schema = definition.events[name]?.schema;
		const decode =
			schema !== undefined && Schema.isSchema(schema)
				? Schema.decodeUnknownEffect<Schema.Codec<unknown>>(schema as Schema.Codec<unknown>)
				: Effect.succeed;

		return Stream.callback<RpcEventPayload<Rpc.PortableDefinition>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => transport.events.on(name, (event) => void Queue.offerUnsafe(queue, event))),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		).pipe(Stream.mapEffect((event) => Effect.map(decode(event.data), (data) => ({ ...event, data }))));
	};

	// Object.fromEntries erases each method's input/output relationship; it is restored by the mapped type, after
	// applying that method's codecs above.
	return { ...methods, events } as unknown as RpcClient<D>;
}

type Arguments<Input> = unknown extends Input
	? [input: Input, options?: RpcCallOptions]
	: undefined extends Input
		? [input?: Input, options?: RpcCallOptions]
		: [input: Input, options?: RpcCallOptions];

type Input<S extends Rpc.Method["input"]> = S extends Schema.Top ? S["Type"] : Rpc.Input<S>;

export type RpcError<M extends Rpc.Method> =
	Rpc.MethodError<M> extends infer E extends Rpc.MethodError<M>
		? E extends E
			? Declared<E["type"], E["data"]>
			: never
		: never;

/**
 * A method: its declared errors, decoded, are failures, and so are what's beside them: the call failing on the way
 * (`UnknownError`, with the client's error as its cause) and a value that doesn't fit its schema.
 */
export type RpcMethod<M extends Rpc.Method> = (
	...args: Arguments<Input<M["input"]>>
) => Effect.Effect<Rpc.Output<M["output"]>, RpcError<M> | Cause.UnknownError | Schema.SchemaError>;

export type RpcClient<D extends Rpc.Definition> = {
	readonly [Name in keyof D["methods"]]: RpcMethod<D["methods"][Name]>;
} & {
	/** Event `name`'s payloads, from every location, while the stream runs; one whose data doesn't fit fails it. */
	readonly events: <Name extends keyof D["events"] & string>(
		name: Name,
	) => Stream.Stream<RpcEvent<D, Name>, Schema.SchemaError>;
};

/** An event's payload as the TUI's client gives it, its data decoded. */
export interface RpcEvent<D extends Rpc.Definition, Name extends keyof D["events"] & string>
	extends Omit<RpcEventPayload<Rpc.PortableDefinition>, "data"> {
	readonly data: Rpc.EventData<D["events"][Name]["schema"]>;
}

const RpcFailure = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	data: Schema.optional(Schema.Unknown),
});

// The promise client normalizes RpcError to { type, message, data },
// dropping the tag used by OpenCode's exported isRpcError guard.
const isRpcError = Schema.is(RpcFailure);

const isUnavailable = (error: Cause.UnknownError) => isRpcError(error.cause) && error.cause.type === "rpc.unavailable";

class Declared<TType extends string, TData = void> extends Data.Error<{
	_tag: TType;
	message: string;
	data: TData;
}> {}
