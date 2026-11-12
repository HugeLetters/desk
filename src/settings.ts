/**
 * The desk's settings, as Effect `Config`: the store, the page's port, and how long a desk call may take. The service
 * reads them from the environment (`DESK_HOME`, `DESK_PORT`); the plugin and its TUI part from their options in
 * `opencode.json` (`home`, `port`, `timeout`) first, then the environment, then the defaults. The one place that
 * knows the store's default location.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The user's home directory. Effect has no API for it; `HOME` is what `os.homedir()` reads first, too. */
const userHome = Config.String("HOME");

/** The store from the environment: `$DESK_HOME`, else `~/.local/share/desk`. */
export const store = Effect.flatMap(Path.Path, (path) =>
	Config.String("DESK_HOME").pipe(
		Config.orElse(() => Config.map(userHome, (home) => path.join(home, ".local", "share", "desk"))),
	),
);

/** The page's preferred port from the environment: `$DESK_PORT`, else 47400. 0: any free port (`Config.Port` would refuse it). */
export const port = Config.Int("DESK_PORT").pipe(Config.withDefault(47400));

const defaultTimeout = Duration.seconds(30);

/**
 * A path from `opencode.json`: a leading `~` is the user's home, as in a shell (the README's example says
 * `"home": "~/.local/share/desk"`). Nothing expands it on the way: JSON isn't a shell.
 */
const expandHome = (configured: string) =>
	configured !== "~" && !configured.startsWith("~/")
		? Effect.succeed(configured)
		: Effect.flatMap(Path.Path, (path) => Effect.map(userHome, (home) => path.join(home, configured.slice(1))));

/** What the plugin and its TUI part read: from their options, then the environment, then the defaults. */
export interface Plugin {
	readonly home: string;
	readonly port: number;
	readonly timeout: Duration.Duration;
}

/**
 * The plugin's settings from its `options` (`opencode.json` `plugins: [{ package, options }]`). An option that's set
 * but isn't valid is reported, and the environment's or the default value used instead.
 */
export const plugin = (
	options: Readonly<Record<string, unknown>>,
): Effect.Effect<Plugin, Config.ConfigError, Path.Path> => {
	const provider = ConfigProvider.fromUnknown(options);
	/** `name` from the options; `fallback` when it's not set, or set to something that isn't `what`. */
	const option = <A, E, R>(
		name: string,
		config: Config.Config<A>,
		what: string,
		fallback: Effect.Effect<A, E, R>,
		show: (value: A) => string = String,
	) =>
		Effect.matchEffect(Config.option(config).parse(provider), {
			onFailure: () =>
				Effect.tap(fallback, (value) =>
					Effect.logWarning(`desk: the ${name} option isn't ${what} (${options[name]}); using ${show(value)}`),
				),
			onSuccess: Option.match({ onNone: () => fallback, onSome: Effect.succeed }),
		});
	return Effect.all({
		home: Effect.flatMap(option("home", Config.String("home"), "a path", store), expandHome),
		port: option("port", Config.Int("port"), "a port", port),
		timeout: option(
			"timeout",
			Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), "timeout"),
			"a duration",
			Effect.succeed(defaultTimeout),
			Duration.format,
		),
	});
};
