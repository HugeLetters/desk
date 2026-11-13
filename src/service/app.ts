/**
 * The desk service, assembled: the store (`Storage`, on disk) and the desk on it, the projects, delivery, the page and the socket.
 * OpenCode is reached only through the plugin instances connected to the socket; tests connect fake ones.
 */
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Clients } from "./clients";
import * as Delivery from "./delivery/delivery";
import { Desk } from "./desk";
import { OpenCode } from "./opencode/opencode";
import { Sessions } from "./opencode/sessions";
import { Storage } from "./storage/storage";
import { Api } from "./transport/api";
import * as Http from "./transport/http";
import * as Socket from "./transport/socket";

export interface Config {
	/** The store: entries, attachments and the socket. */
	readonly store: string;
	readonly socket: string;
	/** The page's port, when it's free; else (and with 0) any free one. */
	readonly port: number;
	/** How long the service waits without clients before `Clients.idle` completes. */
	readonly idle: Duration.Input;
	/** How often undelivered messages are tried again, besides whenever a plugin instance connects. */
	readonly retry?: Duration.Input | undefined;
	/** Whether this service is the outdated side when a plugin's protocol differs (default: the code on disk changed since it loaded). */
	readonly outdated?: Effect.Effect<boolean, never, FileSystem.FileSystem> | undefined;
}

/** Needs the platform (`BunServices.layer`): provided where the service is run, `main.ts` or the tests. */
export const layer = (config: Config) => {
	const core = Layer.mergeAll(Desk.layer, Sessions.layer, Delivery.Failures.layer).pipe(
		Layer.provideMerge(OpenCode.layer),
		Layer.provideMerge(Clients.layer(config.idle)),
	);
	const server =
		config.port === 0 ? Http.server(0) : Http.server(config.port).pipe(Layer.catchCause(() => Http.server(0)));
	// Once the page and the socket are up, the registration says where.
	const publish = Layer.effectDiscard(
		Effect.gen(function* () {
			const api = yield* Api;
			yield* (yield* Storage).publish({ url: api.url, socket: config.socket });
		}),
	);
	return Layer.mergeAll(Http.layer, Socket.layer(config.socket, config.outdated), Delivery.layer(config.retry)).pipe(
		Layer.provideMerge(publish),
		Layer.provideMerge(Api.layer),
		Layer.provideMerge(server),
		Layer.provideMerge(core),
		// The store first, and with it its lock: nothing else starts while another service has the store.
		Layer.provideMerge(Storage.layer(config.store)),
	);
};
