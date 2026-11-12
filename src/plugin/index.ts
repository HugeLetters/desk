/**
 * The desk in OpenCode: a thin, stateless client of the desk service. It adds
 *
 * - `/desk-mode` (`command.ts`), which turns desk mode on or off for the current session (off by default), kept in the
 *   plugin's storage (`modes.ts`), so a session's subagents follow it;
 * - the `desk_*` tools (`tools.ts`), which forward to the service and which only sessions with the desk on get to see.
 *
 * For the service, it's also the way into this OpenCode (`sessions.ts`): it looks sessions up and delivers the user's
 * replies here when the service asks, and tells the service about sessions that move.
 *
 * Options (`opencode.json` `plugins: [{ package, options }]`, read by `settings.ts`): `home` (the store, default
 * `$DESK_HOME` or `~/.local/share/desk`), `port` (the page's preferred port, default `$DESK_PORT` or 47400; any free one
 * when it's taken) and `timeout` (how long a desk call may take before the agent is told the service seems stuck;
 * default 30 seconds).
 */

import * as BunServices from "@effect/platform-bun/BunServices";
import { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServiceInfo from "../service-info";
import * as Settings from "../settings";
import * as Calls from "./calls";
import * as Command from "./command";
import * as Connection from "./connection";
import * as Modes from "./modes";
import * as Sessions from "./sessions";
import * as Tools from "./tools";

export default Plugin.define<Scope.Scope>({
	id: "desk",
	effect: (ctx) =>
		Effect.gen(function* () {
			const settings = yield* Settings.plugin(ctx.options);
			const files = yield* ServiceInfo.files(settings.home);
			const root = yield* Sessions.roots(ctx);
			const modes = Modes.make(ctx, root);
			const connection = yield* Connection.make({
				socket: files.socket,
				start: Connection.startService({ store: settings.home, port: settings.port, log: files.log }),
				directory: ctx.location.directory,
				modes: modes.here,
				serve: Sessions.serve(ctx),
			});
			const sync = yield* Modes.follow(modes, connection);
			yield* sync;
			const calls = Calls.make(connection, settings.timeout, files.registration);

			// A session that moves keeps its desk; the service looks its folder up again, for the desk's name. A session
			// moving in or out of this directory may connect or hang up this instance, too.
			yield* ctx.event.subscribe({ types: ["session.moved"] }).pipe(
				Stream.runForEach((event) =>
					Effect.andThen(
						Effect.ignore(calls.service((client) => client.moved({ session: event.data.sessionID }))),
						sync,
					),
				),
				Effect.ignore,
				Effect.forkScoped,
			);

			yield* Command.register(ctx, { ...calls, modes, sync });
			yield* Tools.register(ctx, { ...calls, modes, root });
		}).pipe(Effect.provide(BunServices.layer), Effect.orDie),
});
