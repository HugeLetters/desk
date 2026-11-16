/**
 * The store's token: one secret per store, so that only who can read it reaches the service: the page by a cookie, a
 * plugin by a bearer header (`service/transport/http.ts`), each let in by a link that carries it (`routes.ts`'s
 * `withToken`). Kept in the macOS Keychain, under {@link keychain} and named by the store's absolute path; the service
 * creates it the first time it runs on the store, and plugins read it there. The `token` setting stands in for it
 * (tests, a service run by hand). Always `Redacted`, so never logged.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Secrets } from "./secrets";
import * as Settings from "./settings";

/** The Keychain service the desk's tokens are kept under, one item per store. */
export const keychain = "desk";

/** Where the store's token is: the Keychain, or, with the `token` setting, that token, in memory. */
export const secrets = Layer.unwrap(
	Effect.gen(function* () {
		const given = yield* Settings.token;
		const { store } = yield* Settings.files;
		return Option.match(given, {
			onNone: () => Secrets.layer(keychain),
			onSome: (token) => Secrets.memory(keychain, { [store]: token }),
		});
	}),
);

/** The store's token; fails while there's none, before the service has first run on the store. */
export const read = Effect.gen(function* () {
	const { store } = yield* Settings.files;
	return yield* Secrets.use((secrets) => secrets.getOrFail(store));
});

/** A new token: 32 random bytes, base64url. */
export const generate = () => Redacted.make(Base64Url.encode(crypto.getRandomValues(new Uint8Array(32))));

/** The store's token, created now if there's none. */
export const getOrCreate = Effect.gen(function* () {
	const { store } = yield* Settings.files;
	const secrets = yield* Secrets;
	const existing = yield* secrets.get(store);
	if (existing !== null) return existing;

	const created = generate();
	yield* secrets.set(store, created);
	return created;
});

/** The token the service lets requests in with: the store's, got or created as it starts. */
export class Token extends Context.Service<Token, Redacted.Redacted<string>>()("desk/Token") {
	static layer = Layer.effect(Token, getOrCreate);
}
