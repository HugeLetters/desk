/**
 * `bun src/service/main.ts`: runs the desk service until it has had no clients for `$DESK_IDLE` (a duration or ms,
 * default 10 minutes) or a newer one replaces it, or a signal comes, then exits. A plugin instance starts it when none
 * answers on the port; started while another one has the store (`<store>/service.json`), it exits at once, and with
 * the port taken by another program, it exits with an error that says so. Its settings are the plugin's options it
 * was started with (`--options '<json>'`, as the plugin got them), then the environment (`DESK_HOME`, `DESK_PORT`,
 * `DESK_IDLE`: run by hand, or in tests), then the defaults (`settings.ts`). Unlike the plugin, it's strict: a setting
 * given but not valid stops it, saying which (exit code 1), rather than giving way to the default.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Settings from "../shared/settings";
import * as Token from "../shared/token";
import * as App from "./app";
import { Clients } from "./clients";
import { Api } from "./transport/api";

const decodeOptions = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const optionsFlag = "--options";

/** The plugin's options, as `startService` hands them over in `argv` (`--options '<json>'`); none without it. */
export const options = (argv: ReadonlyArray<string>) => {
	const at = argv.indexOf(optionsFlag);
	if (at === -1) return Effect.succeed<Settings.Options>({});

	return decodeOptions(argv[at + 1]).pipe(
		Effect.mapError((error) => new Settings.InvalidSetting({ name: optionsFlag, message: error.message })),
	);
};

/** The settings as the service reads them: `argv`'s options, then the environment, strictly. */
export const settings = (argv: ReadonlyArray<string>) =>
	Layer.unwrap(Effect.map(options(argv), (given) => Settings.layer(given, { strict: true })));

/** The service's configuration, from the settings. */
export const configuration = Effect.gen(function* () {
	const config: App.Config = {
		port: yield* Settings.port,
		idle: yield* Settings.idle,
	};
	return config;
});

if (import.meta.main) {
	Effect.gen(function* () {
		const config = yield* configuration;
		yield* Effect.gen(function* () {
			yield* Effect.log(`desk: serving ${yield* Settings.store} on ${(yield* Api).url}`);
			yield* Clients.use((clients) => clients.idle);
			yield* Effect.log("desk: exiting");
		}).pipe(Effect.provide(Layer.fresh(App.layer(config).pipe(Layer.provide(Token.secrets)))));
	}).pipe(
		Effect.provide([BunServices.layer, settings(process.argv)]),
		// The registration is the lock: a second service finds it taken and leaves.
		Effect.catchTag("AlreadyRunning", () => Effect.log("desk: another service is running; exiting")),
		Effect.tapErrorTag("InvalidSetting", ({ name, message }) =>
			Effect.logError(
				`desk: ${name === optionsFlag ? `${optionsFlag} (the plugin's options, as JSON)` : `the ${name} setting`} isn't valid, so the service doesn't start: ${message}`,
			),
		),
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
