/**
 * `bun src/service/main.ts`: runs the desk service until it has had no clients for `$DESK_IDLE` (a duration or ms,
 * default 10 minutes) or a newer one replaces it, or a signal comes, then exits. A plugin instance starts it when none answers on
 * the socket; started while another one has the store (`<store>/service.json`), it exits at once.
 *
 * - `DESK_HOME`: the store (default `~/.local/share/desk`); the socket is `$DESK_HOME/desk.sock`.
 * - `DESK_PORT`: the page's port when it's free (default 47400); else any free one, written to `service.json`.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as ServiceInfo from "../service-info";
import * as Settings from "../settings";
import { Api } from "./api";
import * as App from "./app";
import { Clients } from "./clients";

/** The service's configuration, from the settings. */
export const configuration = Effect.gen(function* () {
	const store = yield* Settings.store;
	return {
		store,
		socket: (yield* ServiceInfo.files(store)).socket,
		port: yield* Settings.port,
		idle: yield* Settings.idle,
	} satisfies App.Config;
});

if (import.meta.main) {
	Effect.gen(function* () {
		const config = yield* configuration;
		yield* Effect.gen(function* () {
			yield* Effect.log(`desk: serving ${config.store} on ${(yield* Api).url}`);
			yield* Clients.use((clients) => clients.idle);
			yield* Effect.log("desk: exiting");
		}).pipe(Effect.provide(Layer.fresh(App.layer(config))));
	}).pipe(
		Effect.provide([BunServices.layer, Settings.layer()]),
		// The registration is the lock: a second service finds it taken and leaves.
		Effect.catchTag("AlreadyRunning", () => Effect.log("desk: another service is running; exiting")),
		// Done (idle, a signal, or another service): exit, whatever still holds the process open (an open page's
		// connection, say). The default teardown exits only after a signal or a failure; done for being idle, it would
		// leave the process waiting on whatever's still open, holding the port. Shutting down is bounded on its own
		// (`App.layer`).
		BunRuntime.runMain({
			teardown: (exit, onExit) =>
				Runtime.defaultTeardown(exit, (code) => {
					onExit(code);
					process.exit(code);
				}),
		}),
	);
}
