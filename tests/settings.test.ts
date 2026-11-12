/** The settings (`src/settings.ts`): the plugin's options over the environment, over the defaults. */
import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Settings from "../src/settings";

/** The plugin's settings for `options`, with `env` as the whole environment. */
const read = (options: Record<string, unknown>, env: Record<string, string>) =>
	Effect.runPromise(
		Effect.all({ store: Settings.store, port: Settings.port, timeout: Settings.timeout }).pipe(
			Effect.provide(
				Layer.mergeAll(
					BunServices.layer,
					ConfigProvider.layer(Settings.provider(options, ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);

test("options first, then DESK_HOME, DESK_PORT and DESK_TIMEOUT, then ~/.local/share/desk, 47400 and 30 seconds", async () => {
	expect(await read({}, { HOME: "/home/me" })).toEqual({
		store: "/home/me/.local/share/desk",
		port: 47400,
		timeout: Duration.seconds(30),
	});
	expect(
		await read({}, { HOME: "/home/me", DESK_HOME: "/store", DESK_PORT: "47401", DESK_TIMEOUT: "2 seconds" }),
	).toEqual({ store: "/store", port: 47401, timeout: Duration.seconds(2) });
	expect(
		await read({ home: "/mine", port: 0, timeout: "5 seconds" }, { HOME: "/home/me", DESK_HOME: "/store" }),
	).toEqual({ store: "/mine", port: 0, timeout: Duration.seconds(5) });
	expect((await read({ timeout: 1500 }, { HOME: "/home/me" })).timeout).toEqual(Duration.millis(1500));
});

test("a setting that isn't valid gives way to the default: the store is an absolute path, ~ isn't expanded", async () => {
	for (const home of ["~/desk", "~", "desk"]) {
		expect((await read({ home }, { HOME: "/home/me" })).store).toBe("/home/me/.local/share/desk");
	}
	expect(await read({ port: "nope", timeout: "soon" }, { HOME: "/home/me" })).toMatchObject({
		port: 47400,
		timeout: Duration.seconds(30),
	});
});
