/**
 * `bun src/service/main.ts`: runs the desk service until it has had no clients for `$DESK_IDLE` ms (default 10
 * minutes) or a newer one replaces it, then exits. A plugin instance starts it when none answers on the socket;
 * started while another one has the store (`<store>/service.json`), it exits at once.
 *
 * - `DESK_HOME`: the store (default `~/.local/share/desk`); the socket is `$DESK_HOME/desk.sock`.
 * - `DESK_PORT`: the page's port when it's free (default 47400); else any free one, written to `service.json`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Api } from "./api";
import * as App from "./app";
import { Clients } from "./clients";
import { releaseNow } from "./registration";
import { answering } from "../plugin/connection";

export const config = (env: Record<string, string | undefined> = process.env) => {
	const store = env.DESK_HOME || join(homedir(), ".local/share/desk");
	return { store, socket: join(store, "desk.sock"), port: Number(env.DESK_PORT || 47400), idle: Number(env.DESK_IDLE || 600_000) };
};

if (import.meta.main) {
	const settings = config();
	// The quick check: a service already answers.
	if (await answering(settings.socket)) {
		console.log("desk: another service is running; exiting");
		process.exit(0);
	}
	/** Exits in 2 s at the latest: open pages (their view streams) and plugin connections don't hold the exit up. */
	const exitSoon = () =>
		setTimeout(() => {
			releaseNow(settings.store);
			process.exit(0);
		}, 2000).unref();
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, exitSoon);
	Effect.gen(function* () {
		yield* Effect.log(`desk: serving ${settings.store} on ${(yield* Api).url}`);
		yield* Clients.use((clients) => clients.idle);
		yield* Effect.log("desk: exiting");
		exitSoon();
	}).pipe(
		Effect.provide(Layer.fresh(App.layer(settings))),
		Effect.catchTag("AlreadyRunning", () => Effect.log("desk: another service is running; exiting")),
		BunRuntime.runMain,
	);
}
