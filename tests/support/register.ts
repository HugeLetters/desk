/** `bun tests/support/register.ts <store>`: takes the store's registration and holds it 4 s ("held"), or says "taken". */
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Registration } from "../../src/service/storage/registration";
import { present } from "./present";

await Effect.runPromise(
	Layer.build(Registration.layer(present(process.argv[2]))).pipe(
		Effect.andThen(Effect.sync(() => console.log("held"))),
		Effect.andThen(Effect.sleep("4 seconds")),
		Effect.scoped,
		Effect.catchTag("AlreadyRunning", () => Effect.sync(() => console.log("taken"))),
		Effect.provide(BunServices.layer),
	),
);
