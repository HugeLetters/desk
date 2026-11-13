/**
 * The store in memory, for tests that are about the desk's rules rather than files: entries kept as their file text
 * (so they round-trip as they do on disk), attachments and the files of entries' directories as bytes. Nobody else
 * edits it, so only transactions change it; its lock is always free, and where the page is goes nowhere.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { type EntryId, parse, serialize } from "../../model/entry";
import type { Backend, Content } from "./storage";

interface Stored {
	readonly data: Uint8Array;
	readonly modified: number;
}

const content = (stored: Stored | undefined): Option.Option<Content> =>
	stored === undefined
		? Option.none()
		: Option.some({ data: new Blob([stored.data.slice()]), modified: stored.modified });

export const memory = (files: Readonly<Record<string, string | Uint8Array>>) =>
	Effect.gen(function* () {
		/** Entry id → its file's text. */
		const entries = yield* Ref.make<ReadonlyMap<EntryId, string>>(new Map());
		/** Path below the store → the attachment. */
		const attachments = yield* Ref.make<ReadonlyMap<string, Stored>>(new Map());
		const encoder = new TextEncoder();
		const directories: ReadonlyMap<string, Stored> = new Map(
			Object.entries(files).map(([path, data]) => [
				path,
				{ data: typeof data === "string" ? encoder.encode(data) : data, modified: 0 },
			]),
		);
		const without = <K, V>(map: ReadonlyMap<K, V>, gone: ReadonlySet<K>): ReadonlyMap<K, V> =>
			new Map([...map].filter(([key]) => !gone.has(key)));

		const backend: Backend = {
			load: Effect.map(Ref.get(entries), (all) =>
				[...all]
					.flatMap(([id, text]) => Option.toArray(parse(id, text)))
					.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)),
			),
			write: (entry) => Ref.update(entries, (all) => new Map(all).set(entry.id, serialize(entry))),
			remove: (id) => Ref.update(entries, (all) => without(all, new Set([id]))),
			attach: (relative, data) =>
				Effect.flatMap(Clock.currentTimeMillis, (modified) =>
					Ref.update(attachments, (all) => new Map(all).set(relative, { data: data.slice(), modified })),
				),
			detach: (files) => Ref.update(attachments, (all) => without(all, new Set(files))),
			attachment: (relative) => Effect.map(Ref.get(attachments), (all) => content(all.get(relative))),
			attachmentUrl: (relative) => Effect.succeed(`memory:${relative}`),
			file: (path) => Effect.succeed(content(directories.get(path))),
			changed: Stream.never,
			publish: () => Effect.void,
		};
		return backend;
	});
