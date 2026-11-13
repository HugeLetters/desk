/**
 * `bun src/service/main.ts`: runs the desk service until it has had no clients for `$DESK_IDLE` (a duration or ms,
 * default 10 minutes) or a newer one replaces it, or a signal comes, then exits. A plugin instance starts it when none
 * answers on the port; started while another one has the store (`<store>/service.json`), it exits at once, and with
 * the port taken by another program, it exits with an error that says so.
 *
 * - `DESK_HOME`: the store (default `~/.local/share/desk`).
 * - `DESK_PORT`: the port of the page and the API, `/rpc` (default 47400).
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as Settings from "../shared/settings";
import * as App from "./app";
import { Clients } from "./clients";
import { Api } from "./transport/api";

/** The service's configuration, from the settings. */
export const configuration = Effect.gen(function* () {
	const config: App.Config = {
		store: yield* Settings.store,
		port: yield* Settings.port,
		idle: yield* Settings.idle,
	};
	return config;
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
		// Not another desk service (that one has the store, above): another program. The page and the plugins find the
		// service by the port, so it doesn't take another one; it fails (exit code 1), saying so.
		Effect.tapErrorTag("PortTaken", ({ port }) =>
			Effect.logError(
				`desk: port ${port} is taken by another program (or a desk service on another store); set DESK_PORT (the desk plugin's port option) to a free port`,
			),
		),
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
