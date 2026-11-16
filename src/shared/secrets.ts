/**
 * macOS Keychain access through `Bun.secrets`, scoped to one Keychain service. Bun only. {@link Secrets.memory} keeps
 * them in memory instead, for tests.
 *
 * ```ts
 * Secrets.forKey("api-token").GetOrFail.pipe(Effect.provide(Secrets.layer("my-app")));
 * ```
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Function_ from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class SecretsError extends Data.TaggedError("SecretsError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Where the secrets are kept: `Bun.secrets`, or a stand-in with its shape. */
type Store = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** Secrets under `service`, kept in `store`. */
const fromStore = Effect.fnUntraced(function* (service: string, store: Store) {
	const use = Effect.fn("secrets.use")(<T>(run: (secrets: Store) => T | PromiseLike<T>) =>
		Effect.tryPromise({
			async try() {
				return run(store);
			},
			catch(error) {
				return new SecretsError({ message: "Bun.secrets call failed", cause: error });
			},
		}),
	);

	/** The secret, or `null` when it isn't stored. */
	function get(name: string) {
		return use((s) => s.get({ service, name })).pipe(
			Effect.map((value) => (value === null ? null : Redacted.make(value))),
		);
	}

	return {
		service,
		get,
		getOrFail: Effect.fn("secrets.getOrFail")(function* (name: string) {
			const value = yield* get(name);
			if (value === null) {
				return yield* new SecretsError({ message: `Missing secret ${name} in ${service}` });
			}
			return value;
		}),
		set(name: string, value: Redacted.Redacted<string>) {
			return use((s) => s.set({ service, name, value: Redacted.value(value) }));
		},
		delete(name: string) {
			return use((s) => s.delete({ service, name }));
		},
	};
});

/** A {@link Store} in memory, starting with `initial` (by name) under `service`. */
const memoryStore = (service: string, initial: Readonly<Record<string, Redacted.Redacted<string>>>): Store => {
	const key = (options: { readonly service: string; readonly name: string }) =>
		JSON.stringify([options.service, options.name]);
	const values = new Map(
		Object.entries(initial).map(([name, value]) => [key({ service, name }), Redacted.value(value)]),
	);

	return {
		get: async (options) => values.get(key(options)) ?? null,
		set: async (options) => void values.set(key(options), options.value),
		delete: async (options) => values.delete(key(options)),
	};
};

export class Secrets extends Context.Service<Secrets>()("desk/Secrets", {
	make: Effect.fn(function* (service: string) {
		return yield* fromStore(service, Bun.secrets);
	}),
}) {
	/** Secrets stored under the given Keychain service name. */
	static layer = Function_.flow(Secrets.make, Layer.effect(Secrets));

	/**
	 * Secrets under `service` in memory, never the Keychain: `initial` to begin with, by name.
	 * @default no secrets
	 */
	static memory = (service: string, initial: Readonly<Record<string, Redacted.Redacted<string>>> = {}) =>
		Layer.effect(Secrets, fromStore(service, memoryStore(service, initial)));

	/** Accessors bound to one secret name. */
	static forKey(name: string) {
		return {
			Get: Secrets.use((s) => s.get(name)),
			GetOrFail: Secrets.use((s) => s.getOrFail(name)),
			set(value: Redacted.Redacted<string>) {
				return Secrets.use((s) => s.set(name, value));
			},
			Delete: Secrets.use((s) => s.delete(name)),
		};
	}
}
