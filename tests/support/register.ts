/**
 * `bun tests/support/register.ts <store>`: opens the store, taking its registration, and holds it 4 s ("held"), or says
 * "taken".
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Storage } from "../../src/service/storage/storage";
import { present } from "./present";

await Effect.runPromise(
	Layer.build(Storage.layer(present(process.argv[2]))).pipe(
		Effect.andThen(Effect.sync(() => console.log("held"))),
		Effect.andThen(Effect.sleep("4 seconds")),
		Effect.scoped,
		Effect.catchTag("AlreadyRunning", () => Effect.sync(() => console.log("taken"))),
		Effect.provide(BunServices.layer),
	),
);
