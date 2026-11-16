/**
 * The desk in OpenCode: a thin, stateless client of the desk service. It adds
 *
 * - `/desk-mode` (`command.ts`), which turns desk mode on or off for the current session (off by default), kept in the
 *   plugin's storage (`modes.ts`), so a session's subagents follow it;
 * - the `desk_*` tools (`tools.ts`), which forward to the service and which only sessions with the desk on get to see;
 * - the TUI badge's data (`badge.ts`), over OpenCode's plugin RPC (`badge-rpc.ts`): a session's desk while it's in
 *   desk mode and this instance is connected, so the TUI part never talks to the service itself.
 *
 * For the service, it's also the way into this OpenCode (`sessions.ts`): it looks sessions up and delivers the user's
 * replies here when the service asks, and tells the service about sessions that move. Its options are the settings
 * (`settings.ts`).
 */

import * as BunServices from "@effect/platform-bun/BunServices";
import { Plugin } from "@opencode/plugin/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { invalidSetting } from "../model/wording";
import { Secrets } from "../shared/secrets";
import * as Settings from "../shared/settings";
import * as Token from "../shared/token";
import * as Badge from "./badge";
import * as Calls from "./calls";
import * as Command from "./command";
import * as Connection from "./connection";
import * as Modes from "./modes";
import * as Sessions from "./sessions";
import * as Tools from "./tools";

export default Plugin.define<Scope.Scope>({
	id: "desk",
	effect: Effect.fnUntraced(
		function* (ctx) {
			const settings = yield* Settings.all.pipe(Effect.catchTag("InvalidSetting", Effect.succeed));
			const getRootSessionId = yield* Sessions.createRootSessionLookup(ctx);
			const modes = Modes.make(ctx, getRootSessionId);

			// A setting that isn't valid doesn't crash OpenCode's plugin load, nor is it replaced by a default: the plugin
			// loads, connects to nothing and starts nothing, and says what to fix to whoever uses the desk.
			if (settings instanceof Settings.InvalidSetting) {
				const calls = Calls.unavailable(invalidSetting(settings.name, settings.message));
				yield* Command.register(ctx, { calls, modes, sync: Effect.void });
				yield* Tools.register(ctx, { calls, modes, getRootSessionId });
				yield* Badge.register(ctx, { connection: { links: Stream.make(Option.none()) }, modes, getRootSessionId });
				return;
			}

			const { port, files, timeout } = settings;
			const { store, registration } = files;
			const secrets = yield* Secrets;
			const connection = yield* Connection.make({
				port,
				start: Connection.startService(ctx.options),
				registration,
				directory: ctx.location.directory,
				// The store's token, as the service made it in the Keychain (`token.ts`).
				token: secrets.getOrFail(store),
				modes: modes.here,
				serve: Sessions.serve(ctx),
			});
			const sync = yield* Modes.follow(modes, connection);
			yield* sync;
			const calls = Calls.make(connection, timeout, registration);

			// A session that moves keeps its desk; the service looks its folder up again, for the desk's name. A session
			// moving in or out of this directory may connect or hang up this instance, too.
			// One failed `moved` doesn't end the subscription (the inner `ignore`); a failure of OpenCode's event stream
			// does, and a forked fiber's failure goes nowhere, so there's nothing more to ignore.
			yield* ctx.event.subscribe({ types: ["session.moved"] }).pipe(
				Stream.runForEach((event) =>
					calls
						.service((client) => client.moved({ session: event.data.sessionID }))
						.pipe(Effect.ignore, Effect.andThen(sync)),
				),
				Effect.forkScoped,
			);

			yield* Command.register(ctx, { calls, modes, sync });
			yield* Tools.register(ctx, { calls, modes, getRootSessionId });
			yield* Badge.register(ctx, { connection, modes, getRootSessionId });
		},
		(effect, ctx) =>
			effect.pipe(
				Effect.provide(Token.secrets),
				Effect.provide([BunServices.layer, Settings.layer(ctx.options)]),
				Effect.orDie,
			),
	),
});
