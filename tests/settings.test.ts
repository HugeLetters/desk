/** The settings (`src/shared/settings.ts`): the plugin's options over the environment, over the defaults. */
import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { Port } from "../src/model/paths";
import * as Settings from "../src/shared/settings";
import { D } from "./support/ids";

/** What `Settings.layer` reads, with `env` as the whole environment: `options` over `DESK_<NAME>`. */
const provider = (options: Record<string, unknown>, env: Record<string, string>) =>
	ConfigProvider.orElse(
		Settings.optionsProvider(options),
		ConfigProvider.fromEnv({ env }).pipe(ConfigProvider.constantCase),
	);

/** The plugin's settings for `options`, with `env` as the whole environment. */
const read = (options: Record<string, unknown>, env: Record<string, string>) =>
	Effect.runPromise(
		Effect.all({ store: Settings.store, port: Settings.port, timeout: Settings.timeout }).pipe(
			Effect.provide(Layer.mergeAll(BunServices.layer, ConfigProvider.layer(provider(options, env)))),
		),
	);

test("options first, then DESK_HOME, DESK_PORT and DESK_TIMEOUT, then ~/.local/share/desk, 47400 and 30 seconds", async () => {
	expect(await read({}, { HOME: "/home/me" })).toEqual({
		store: D("/home/me/.local/share/desk"),
		port: Port.make(47400),
		timeout: Duration.seconds(30),
	});
	expect(
		await read({}, { HOME: "/home/me", DESK_HOME: "/store", DESK_PORT: "47401", DESK_TIMEOUT: "2 seconds" }),
	).toEqual({ store: D("/store"), port: Port.make(47401), timeout: Duration.seconds(2) });
	expect(
		await read({ home: "/mine", port: 47402, timeout: "5 seconds" }, { HOME: "/home/me", DESK_HOME: "/store" }),
	).toEqual({ store: D("/mine"), port: Port.make(47402), timeout: Duration.seconds(5) });
	expect((await read({ timeout: 1500 }, { HOME: "/home/me" })).timeout).toEqual(Duration.millis(1500));
});

test("a leading ~ in the store is the user's home; a relative store isn't valid", async () => {
	expect((await read({ home: "~/desk" }, { HOME: "/home/me" })).store).toBe(D("/home/me/desk"));
	expect((await read({ home: "~" }, { HOME: "/home/me" })).store).toBe(D("/home/me"));
	expect((await read({ home: "/a/~b" }, { HOME: "/home/me" })).store).toBe(D("/a/~b"));
	expect((await read({}, { HOME: "/home/me", DESK_HOME: "~/env" })).store).toBe(D("/home/me/env"));
});

test("a setting that isn't valid fails, naming it, and is never replaced by its default", async () => {
	const failure = async (options: Record<string, unknown>) => {
		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					Settings.all,
					Layer.mergeAll(BunServices.layer, ConfigProvider.layer(provider(options, { HOME: "/home/me" }))),
				),
			),
		);
		return Result.isFailure(result) ? result.failure : undefined;
	};
	expect(await failure({ home: "a/~b" })).toMatchObject({ _tag: "InvalidSetting", name: "home" });
	for (const port of [0, -1, 65536, 1.5, "nope"])
		expect(await failure({ port })).toMatchObject({ _tag: "InvalidSetting", name: "port" });
	expect(await failure({ timeout: "soon" })).toMatchObject({ _tag: "InvalidSetting", name: "timeout" });
	expect(await failure({ port: 5000 })).toBeUndefined();
});

test("an entry's layer puts the options and the environment in front of a provider already there", async () => {
	const outer = ConfigProvider.layer(ConfigProvider.fromUnknown({ desk: { port: "1", timeout: "2 seconds" } }));
	const settings = await Effect.runPromise(
		Effect.all({ port: Settings.port, timeout: Settings.timeout }).pipe(
			Effect.provide(Layer.provide(Settings.layer({ port: 2 }), outer)),
		),
	);
	expect(settings.port).toBe(Port.make(2));
	if (process.env.DESK_TIMEOUT === undefined) expect(settings.timeout).toEqual(Duration.seconds(2));
});

test("a setting given but not valid fails, saying which; one not given is still its default", async () => {
	const read = (options: Record<string, unknown>) =>
		Effect.runPromise(
			Effect.result(
				Effect.all({ port: Settings.port, idle: Settings.idle }).pipe(Effect.provide(Settings.layer(options))),
			),
		);
	const failed = await read({ port: "nope" });
	expect(Result.isFailure(failed) && failed.failure).toMatchObject({ _tag: "InvalidSetting", name: "port" });
	if (process.env.DESK_PORT === undefined && process.env.DESK_IDLE === undefined)
		expect(await read({})).toEqual(Result.succeed({ port: Port.make(47400), idle: Duration.minutes(10) }));
});

test("idle is a duration, as text or ms, else 10 minutes", async () => {
	const idle = (options: Record<string, unknown>, env: Record<string, string>) =>
		Effect.runPromise(Settings.idle.pipe(Effect.provide(ConfigProvider.layer(provider(options, env)))));
	expect(await idle({}, {})).toEqual(Duration.minutes(10));
	expect(await idle({}, { DESK_IDLE: "1000" })).toEqual(Duration.millis(1000));
	expect(await idle({ idle: "2 minutes" }, { DESK_IDLE: "1000" })).toEqual(Duration.minutes(2));
});

test("the token, standing in for the Keychain's: none unless given, the options' over DESK_TOKEN, and redacted", async () => {
	const token = (options: Record<string, unknown>, env: Record<string, string>) =>
		Effect.runPromise(Settings.token.pipe(Effect.provide(ConfigProvider.layer(provider(options, env)))));
	expect(Option.isNone(await token({}, {}))).toBe(true);
	const given = await token({}, { DESK_TOKEN: "from-env" });
	expect(Option.map(given, Redacted.value)).toEqual(Option.some("from-env"));
	expect(String(Option.getOrThrow(given))).not.toContain("from-env");
	expect(Option.map(await token({ token: "mine" }, { DESK_TOKEN: "from-env" }), Redacted.value)).toEqual(
		Option.some("mine"),
	);
});
