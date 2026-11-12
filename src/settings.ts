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

// TODO main | makes sense but most of this belongs to a code comments, not a jsdoc | by Evgenii Perminov at Thu, 12 Nov 2026 23:48:13 GMT
/**
 * The store: `home`, else `~/.local/share/desk`. A leading `~` is the user's home. In a terminal the shell replaces
 * `~` before a program sees it, but OpenCode hands over `opencode.json`'s strings as written, so without this
 * `"home": "~/.local/share/desk"` would be a folder literally named `~` in the current directory.
 */
export const store = Effect.gen(function* () {
	const path = yield* Path.Path;
	// TODO main | why are we asking for HOME and then home? | by Evgenii Perminov at Thu, 12 Nov 2026 23:44:23 GMT
	const user = yield* Config.String("HOME");
	const home = Config.map(Config.String("home"), (configured) =>
		configured === "~" || configured.startsWith("~/") ? path.join(user, configured.slice(1)) : configured,
	);
	return yield* setting("home", home, path.join(user, ".local", "share", "desk"));
});

/** The page's preferred port, else 47400. 0: any free port (`Config.Port` would refuse it). */
// TODO main | maybe add non negative filter still? | by Evgenii Perminov at Thu, 12 Nov 2026 23:43:04 GMT
export const port = setting("port", Config.Int("port"), 47400);

/** How long the service runs without clients before it exits, in ms; else 10 minutes. */
// TODO main | should be a duration, thats what it is | by Evgenii Perminov at Thu, 12 Nov 2026 23:42:36 GMT
export const idle = setting("idle", Config.Int("idle"), 600_000);

/** How long a desk call may take before the agent is told the service seems stuck: a duration or ms, else 30 seconds. */
export const timeout = setting(
	"timeout",
	Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), "timeout"),
	Duration.seconds(30),
);

/** What the TUI opens a link with, else `open`; tests replace it. */
export const opener = setting("opener", Config.String("opener"), "open");
