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

/**
 * `provider` over the process's environment, for an entry and everything below it, added in front of whatever provider
 * was already there (still asked for anything these two don't have). The service's has no options.
 */
export const layer = (options: Options = {}) =>
	ConfigProvider.layerAdd(provider(options, ConfigProvider.fromEnv()), { asPrimary: true });

/** Setting `name`, as `config`, else `fallback`. One that's set but isn't valid is reported, and the fallback used. */
const setting = <A>(name: string, config: Config.Config<A>, fallback: A) =>
	config.pipe(
		Config.nested("desk"),
		Config.withDefault(fallback),
		Effect.catch((error) =>
			Effect.as(Effect.logWarning(`desk: ignoring the ${name} setting, using its default: ${error.message}`), fallback),
		),
	);

/** The store: the `home` setting (`DESK_HOME`), else `~/.local/share/desk`; a leading `~` is the user's home. */
export const store = Effect.gen(function* () {
	const path = yield* Path.Path;
	// Not the setting: `HOME` is the user's home directory, the environment's own, where the default store is and what
	// `~` stands for. The setting is `home` under `desk`, the desk's home.
	const userHome = yield* Config.String("HOME");
	// In a terminal the shell replaces `~` before a program sees it, but OpenCode hands over `opencode.json`'s strings
	// as written: without this, `"home": "~/.local/share/desk"` would be a folder literally named `~` here.
	const home = Config.map(Config.String("home"), (configured) =>
		configured === "~" || configured.startsWith("~/") ? path.join(userHome, configured.slice(1)) : configured,
	);
	return yield* setting("home", home, path.join(userHome, ".local", "share", "desk"));
});

/** The page's port, else 47400. Never 0 (any free port): the page's address and the clients' way to it stay put. */
export const port = setting("port", Config.Port("port"), 47400);

/** A duration, as text (`"5 seconds"`) or ms. */
const duration = (name: string) =>
	Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), name);

/** How long the service runs without clients before it exits, else 10 minutes. */
export const idle = setting("idle", duration("idle"), Duration.minutes(10));

/** How long a desk call may take before the agent is told the service seems stuck, else 30 seconds. */
export const timeout = setting("timeout", duration("timeout"), Duration.seconds(30));

/** What the TUI opens a link with, else `open`; tests replace it. */
export const opener = setting("opener", Config.String("opener"), "open");
