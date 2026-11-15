/**
 * Paths and ports that aren't just strings and numbers: branded, with checks. Parsed where they come in (the settings,
 * the API, an entry's file, a request's path) and trusted past that. URLs are the platform's `URL`, and
 * `Schema.URLFromString` on the wire.
 */
import * as Schema from "effect/Schema";

/**
 * A path from the root: starts with `/`. OpenCode's brand (`@opencode/schema/schema`'s `AbsolutePath`), so its
 * directories (a location's, a session's) are these as they come; OpenCode's has no check, this one does.
 */
export const AbsolutePath = Schema.String.check(
	Schema.makeFilter((path) => path.startsWith("/") || "an absolute path, starting with /"),
).pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

/** Whether `path`'s `..` segments climb above where it starts. */
const escapes = (path: string) => {
	let depth = 0;
	for (const segment of path.split("/")) {
		if (segment === "..") depth -= 1;
		else if (segment !== "" && segment !== ".") depth += 1;

		if (depth < 0) return true;
	}

	return false;
};

/** A path below some directory (the store, an entry's): not absolute, and its `..` segments never climb out of it. */
export const RelativePath = Schema.String.check(
	Schema.makeFilter(
		(path) => (!path.startsWith("/") && !escapes(path)) || "a relative path that stays below where it starts",
	),
).pipe(Schema.brand("RelativePath"));
export type RelativePath = typeof RelativePath.Type;

/** A TCP port to listen on or connect to: 1 to 65535. */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.brand("Port"));
export type Port = typeof Port.Type;
