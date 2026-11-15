import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { AbsolutePath, Port } from "../model/paths";

/** Untyped options record */
export type Options = Readonly<Record<string, unknown>>;

/**
 * Settings ConfigProvider from {@link Options}
 */
export const optionsProvider = (options: Options) => {
	// options nested under desk so that desk specific options dont conflict w/ system env - for example HOME vs DESK_HOME
	return ConfigProvider.fromUnknown({ desk: options });
};

/**
 * Default ConfigProvider layer for configuration:
 * - {@link Options} provider
 * - Constant-case env provider
 * - Any other providers setup
 */
export const layer = (options: Options = {}) => {
	const provider = ConfigProvider.orElse(
		optionsProvider(options),
		ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase),
	);

	return ConfigProvider.layerAdd(provider, { asPrimary: true });
};

/** Desk Setting config w/ a fallback */
const setting = <A>(name: string, config: Config.Config<A>, fallback: A) =>
	config.pipe(
		Config.nested("desk"),
		Config.withDefault(fallback),
		Effect.catch((error) =>
			Effect.as(Effect.logWarning(`desk: ignoring the ${name} setting, using its default: ${error.message}`), fallback),
		),
	);

/**
 * Location of desk storage: an absolute path, or one from `~`, which is expanded.
 * @default `~/.local/share/desk`
 */
export const store = Effect.gen(function* () {
	const path = yield* Path.Path;

	// Not the setting: `HOME` is the user's home directory, the environment's own, where the default store is and what
	// `~` stands for. The setting is `home` under `desk`, the desk's home.
	const userHome = yield* Config.String("HOME");

	// In a terminal the shell replaces `~` before a program sees it, but OpenCode hands over `opencode.json`'s strings
	// as written: without this, `"home": "~/.local/share/desk"` would be a folder literally named `~` here.
	const Home = Schema.String.pipe(
		Schema.decodeTo(
			AbsolutePath,
			SchemaTransformation.transform({
				decode: (configured) =>
					configured === "~" || configured.startsWith("~/") ? path.join(userHome, configured.slice(1)) : configured,
				encode: (home) => home,
			}),
		),
	);
	return yield* setting(
		"home",
		Config.schema(Home, "home"),
		AbsolutePath.make(path.join(userHome, ".local", "share", "desk")),
	);
});

/**
 * Service port, 1 to 65535.
 * @default 47400
 */
export const port = setting("port", Config.schema(Port, "port"), Port.make(47400));

/** Duration config */
const duration = (name: string) =>
	Config.schema(Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]), name);

/**
 * How long the service runs without clients before it exits.
 * @default 10 minutes
 * */
export const idle = setting("idle", duration("idle"), Duration.minutes(10));

/**
 * How long before a desk call is considered timed-out
 * @default 30 seconds
 */
export const timeout = setting("timeout", duration("timeout"), Duration.seconds(30));

/**
 * What shell command is used to open links.
 * @default open
 */
export const opener = setting("opener", Config.String("opener"), "open");
