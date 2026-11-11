/**
 * The desk service, assembled: the store and the desk on it, the projects, delivery, the page and the socket.
 * OpenCode is reached only through the plugin instances connected to the socket; tests connect fake ones.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Delivery from "../delivery";
import { Desk } from "../desk";
import { OpenCode } from "../opencode";
import { Sessions } from "../sessions";
import { Store } from "../store";
import { Api } from "./api";
import { Clients } from "./clients";
import * as Http from "./http";
import { Registration } from "./registration";
import * as Socket from "./socket";

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

export const layer = (config: Config) => {
	const core = Layer.mergeAll(Desk.layer, Sessions.layer, Delivery.Failures.layer).pipe(
		Layer.provideMerge(Store.layer(config.store)),
		Layer.provideMerge(OpenCode.layer),
		Layer.provideMerge(Clients.layer(config.idle)),
		Layer.provideMerge(BunServices.layer),
	);
	const server =
		config.port === 0 ? Http.server(0) : Http.server(config.port).pipe(Layer.catchCause(() => Http.server(0)));
	// Once the page and the socket are up, the registration says where.
	const publish = Layer.effectDiscard(
		Effect.gen(function* () {
			const api = yield* Api;
			yield* (yield* Registration).publish({ url: api.url, socket: config.socket });
		}),
	);
	return Layer.mergeAll(
		Http.layer(config.store),
		Socket.layer(config.socket, config.outdated),
		Delivery.layer(config.retry),
	).pipe(
		Layer.provideMerge(publish),
		Layer.provideMerge(Api.layer),
		Layer.provideMerge(server),
		Layer.provideMerge(core),
		// The lock first: nothing else starts while another service has the store.
		Layer.provideMerge(Registration.layer(config.store).pipe(Layer.provide(BunServices.layer))),
	);
};
