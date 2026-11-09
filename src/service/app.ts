/**
 * The desk service, assembled: the store and the desk on it, the projects, delivery, the page and the socket.
 * OpenCode is reached only through the plugin instances connected to the socket; tests connect fake ones.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Desk } from "../desk";
import * as Delivery from "../delivery";
import { OpenCode } from "../opencode";
import { Projects } from "../projects";
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
	readonly outdated?: (() => boolean) | undefined;
}

/**
 * `layer`, with its shutdown given at most `limit`. The page server's waits for its open requests, and an open page's
 * view stream never ends: unbounded, the service couldn't stop while a page is open.
 */
const bounded = <A, E, R>(layer: Layer.Layer<A, E, R>, limit: Duration.Input) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			yield* Effect.addFinalizer(() => Effect.ignore(Effect.timeout(Scope.close(scope, Exit.void), limit)));
			return yield* Layer.buildWithScope(layer, scope);
		}),
	);

export const layer = (config: Config) => {
	const core = Layer.mergeAll(Desk.layer, Projects.layer, Delivery.Failures.layer).pipe(
		Layer.provideMerge(Store.layer(config.store)),
		Layer.provideMerge(OpenCode.layer),
		Layer.provideMerge(Clients.layer(config.idle)),
		Layer.provideMerge(BunServices.layer),
	);
	const server = bounded(config.port === 0 ? Http.server(0) : Http.server(config.port).pipe(Layer.catchCause(() => Http.server(0))), "1 second");
	// Once the page and the socket are up, the registration says where.
	const publish = Layer.effectDiscard(
		Effect.gen(function* () {
			const api = yield* Api;
			yield* (yield* Registration).publish({ url: api.url, socket: config.socket });
		}),
	);
	return Layer.mergeAll(Http.layer(config.store), Socket.layer(config.socket, config.outdated), Delivery.layer(config.retry)).pipe(
		Layer.provideMerge(publish),
		Layer.provideMerge(Api.layer),
		Layer.provideMerge(server),
		Layer.provideMerge(core),
		// The lock first: nothing else starts while another service has the store.
		Layer.provideMerge(Registration.layer(config.store).pipe(Layer.provide(BunServices.layer))),
	);
};
