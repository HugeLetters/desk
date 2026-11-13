/**
 * The API's version (`api.ts`): a hash of the contract's code, so nothing is bumped by hand. Plugin and service
 * compare theirs on `hello`. Here, not in `api.ts`: it reads files, and the page, which imports the API, runs in a
 * browser.
 */

import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * The contract's code: the API, what it imports from the desk, and the dependencies' versions (`bun.lock`, for the
 * OpenCode schemas). Only these: a change to either side's own code doesn't make the other side outdated, so the
 * service can be restarted on its own, and the plugin reloaded on its own.
 */
const contract = ["src/api/api.ts", "src/model/entry.ts", "src/model/errors.ts", "bun.lock"].map(
	(file) => new URL(`../../${file}`, import.meta.url).pathname,
);

const hash = (texts: ReadonlyArray<string>) =>
	Bun.hash(contract.map((file, index) => `${file}\0${texts[index]}`).join("\0")).toString(36);

/** The contract's version as it's on disk now: a hash of its code. Nothing is bumped by hand. */
export const build = Effect.flatMap(FileSystem.FileSystem, (fs) =>
	Effect.map(
		Effect.forEach(contract, (file) => fs.readFileString(file)),
		hash,
	),
);

/**
 * The version this side speaks: the contract's code it loaded. Plugin and service compare it on `hello`. A hash can't
 * say which side is older; the service decides (`transport/rpc.ts`). Read while the module loads, synchronously: both
 * sides need it before any of their services exist.
 */
export const protocol = hash(contract.map((file) => readFileSync(file, "utf8")));
