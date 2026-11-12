/**
 * The desk's settings, as Effect `Config`, each under `desk`: the store (`home`), the page's port, how long the service
 * waits without clients (`idle`), how long a desk call may take (`timeout`), and what opens a link (`opener`). Everyone
 * reads them the same way; where they come from is the `ConfigProvider` each entry provides (`layer`): the plugin's
 * options in `opencode.json` over the environment (`DESK_HOME`, `DESK_PORT`, …) for the plugin and its TUI part, the
 * environment alone for the service. The one place that knows the defaults.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Options as `opencode.json` gives them (`plugins: [{ package, options }]`). */
export type Options = Readonly<Record<string, unknown>>;

/**
 * Where the settings come from: `options`, as they're named (`home`, `port`), over `environment`, where each is
 * `DESK_` and its name in constant case (`DESK_HOME`, `DESK_PORT`). Other keys (`HOME`) are the environment's.
 */
export const provider = (options: Options, environment: ConfigProvider.ConfigProvider) =>
	ConfigProvider.orElse(ConfigProvider.fromUnknown({ desk: options }), ConfigProvider.constantCase(environment));

/** `provider` over the environment, for an entry and everything below it. The service's has no options. */
export const layer = (options: Options = {}) =>
	ConfigProvider.layer(Effect.map(ConfigProvider.ConfigProvider, (environment) => provider(options, environment)));

/** Setting `name`, as `config`, else `fallback`. One that's set but isn't valid is reported, and the fallback used. */
const setting = <A>(name: string, config: Config.Config<A>, fallback: A) =>
	config.pipe(
		Config.nested("desk"),
		Config.withDefault(fallback),
		Effect.catch((error) =>
			Effect.as(Effect.logWarning(`desk: ignoring the ${name} setting, using its default: ${error.message}`), fallback),
		),
	);

/** A path that doesn't depend on where it's read from: `~` isn't one (nothing expands it; JSON isn't a shell). */
const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//, { expected: "an absolute path" }));

/** The store: `home`, else `~/.local/share/desk`. */
export const store = Effect.gen(function* () {
	const path = yield* Path.Path;
	const user = yield* Config.String("HOME");
	return yield* setting("home", Config.schema(AbsolutePath, "home"), path.join(user, ".local", "share", "desk"));
});

/** The page's preferred port, else 47400. 0: any free port (`Config.Port` would refuse it). */
export const port = setting("port", Config.Int("port"), 47400);

/** How long the service runs without clients before it exits, in ms; else 10 minutes. */
export const idle = setting("idle", Config.Int("idle"), 600_000);

/** How long a desk call may take before the agent is told the service seems stuck: a duration or ms, else 30 seconds. */
export const timeout = setting(
	"timeout",
	Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), "timeout"),
	Duration.seconds(30),
);

/** What the TUI opens a link with, else `open`; tests replace it. */
export const opener = setting("opener", Config.String("opener"), "open");
