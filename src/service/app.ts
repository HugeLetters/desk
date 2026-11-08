/**
 * The desk service, assembled: the store and the desk on it, the projects, delivery, the page and the socket.
 * `OpenCode`'s `Connect` is the one seam to the outside: `OpenCode.client` in `main.ts`, a fake in tests.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import { Desk } from "../desk";
import * as Delivery from "../delivery";
import { type Connect, OpenCode } from "../opencode";
import { Projects } from "../projects";
import { Store } from "../store";
import { Api } from "./api";
import { Clients } from "./clients";
import * as Http from "./http";
import * as Socket from "./socket";

export interface Config {
	/** The store: entries, attachments, the socket and the project cache. */
	readonly store: string;
	readonly socket: string;
	/** The page's port; 0 picks a free one. */
	readonly port: number;
	/** How long the service waits without clients before `Clients.idle` completes. */
	readonly idle: Duration.Input;
	/** How often undelivered messages are tried again, besides whenever an OpenCode server attaches. */
	readonly retry?: Duration.Input | undefined;
	readonly connect: Connect;
}

export const layer = (config: Config) => {
	const core = Layer.mergeAll(Desk.layer, Projects.layer(config.store)).pipe(
		Layer.provideMerge(Store.layer(config.store)),
		Layer.provideMerge(OpenCode.layer(config.connect)),
		Layer.provideMerge(Clients.layer(config.idle)),
		Layer.provideMerge(BunServices.layer),
	);
	return Layer.mergeAll(Http.layer(config.store), Socket.layer(config.socket), Delivery.layer(config.retry)).pipe(
		Layer.provideMerge(Api.layer),
		Layer.provideMerge(Http.server(config.port)),
		Layer.provideMerge(core),
	);
};
