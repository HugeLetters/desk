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

/**
 * A path from `opencode.json`: a leading `~` is the user's home, as in a shell (the README's example says
 * `"home": "~/.local/share/desk"`). Nothing expands it on the way: JSON isn't a shell.
 */
// TODO main | why have that just to expand ~ to home? | by Evgenii Perminov at Thu, 12 Nov 2026 21:48:31 GMT
const expandHome = (configured: string) =>
	configured !== "~" && !configured.startsWith("~/")
		? Effect.succeed(configured)
		: Effect.flatMap(Path.Path, (path) => Effect.map(userHome, (home) => path.join(home, configured.slice(1))));

/** What the plugin reads: from its options, then the environment, then the defaults. */
export interface Plugin {
	/** The store. */
	readonly home: string;
	/** The page's preferred port, for a service the plugin starts. */
	readonly port: number;
	/** How long a desk call may take before the agent is told the service seems stuck. */
	readonly timeout: Duration.Duration;
}

/** Options as `opencode.json` gives them (`plugins: [{ package, options }]`). */
type Options = Readonly<Record<string, unknown>>;

/**
 * Option `name` as `config`; `fallback` when it's not set. One that's set but isn't `what` is reported, and the
 * fallback used instead.
 */
const option = <A, E, R>(
	options: Options,
	name: string,
	config: Config.Config<A>,
	what: string,
	fallback: Effect.Effect<A, E, R>,
	show: (value: A) => string = String,
) =>
	// TODO main | just turn options into a config provider w/ fallback env config provider, thats it. and just read from config then - and no need to split different ways to read config(w/ or w/o options) - everyone just reads Config and you just provide whichever provider necessary | by Evgenii Perminov at Thu, 12 Nov 2026 21:52:49 GMT
	Effect.matchEffect(Config.option(config).parse(ConfigProvider.fromUnknown(options)), {
		// TODO main | why not just log the error here w/ name provided value? then you dont need what | by Evgenii Perminov at Thu, 12 Nov 2026 21:48:57 GMT
		onFailure: () =>
			Effect.tap(fallback, (value) =>
				Effect.logWarning(`desk: the ${name} option isn't ${what} (${options[name]}); using ${show(value)}`),
			),
		onSuccess: Option.match({ onNone: () => fallback, onSome: Effect.succeed }),
	});

/** The store, for the plugin and its TUI part: the `home` option, else as the service reads it. */
export const home = (options: Options) =>
	// TODO main | why is store a fallback to home? | by Evgenii Perminov at Thu, 12 Nov 2026 21:52:17 GMT
	Effect.flatMap(option(options, "home", Config.String("home"), "a path", store), expandHome);

/** The plugin's settings from its options. */
export const plugin = (options: Options) =>
	Effect.all({
		home: home(options),
		port: option(options, "port", Config.Int("port"), "a port", port),
		timeout: option(
			options,
			"timeout",
			Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), "timeout"),
			"a duration",
			Effect.succeed(Duration.seconds(30)),
			Duration.format,
		),
	});
