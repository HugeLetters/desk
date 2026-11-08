/**
 * `bun src/service/main.ts`: runs the desk service until it has had no clients for `$DESK_IDLE` ms (default 10
 * minutes), then exits. A plugin instance starts it when none answers on the socket; started while another one runs,
 * it exits at once.
 *
 * - `DESK_HOME`: the store (default `~/.local/share/desk`); the socket is `$DESK_HOME/desk.sock`.
 * - `DESK_PORT`: the page's port (default 47400).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OpenCode } from "../opencode";
import * as App from "./app";
import { Clients } from "./clients";
import { answering } from "./socket";

export const config = (env: Record<string, string | undefined> = process.env) => {
	const store = env.DESK_HOME || join(homedir(), ".local/share/desk");
	return { store, socket: join(store, "desk.sock"), port: Number(env.DESK_PORT || 47400), idle: Number(env.DESK_IDLE || 600_000) };
};

if (import.meta.main) {
	const settings = config();
	// The socket is the lock; check it before taking the port, so a second service leaves quietly.
	if (await answering(settings.socket)) {
		console.log("desk: another service is running; exiting");
		process.exit(0);
	}
	Effect.gen(function* () {
		yield* Effect.log(`desk: serving ${settings.store} on http://127.0.0.1:${settings.port}/`);
		yield* Clients.use((clients) => clients.idle);
		yield* Effect.log("desk: no clients left; exiting");
	}).pipe(
		Effect.provide(Layer.fresh(App.layer({ ...settings, connect: OpenCode.client }))),
		Effect.catchTag("AlreadyRunning", () => Effect.log("desk: another service is running; exiting")),
		BunRuntime.runMain,
	);
}
