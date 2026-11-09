/**
 * The store: one flat directory (`~/.local/share/desk/`, or `$DESK_HOME`) of `<entry id>.md` files, and the
 * attachments the user sent, in `attachments/`. Other files there (the service's socket, log and registration) aren't
 * entries.
 *
 * The files are the desk's only state: nothing here remembers entries between reads. `load` reads them all each time.
 * A write lands whole (written beside the file, then renamed over it), so a read never sees half an entry. `changed`
 * only says that something may have changed (any entry file event, ours included); readers read again.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { type Entry, type EntryId, fileName, idOf, newId, parse, serialize } from "./entry";

export class Store extends Context.Service<
	Store,
	{
		readonly root: string;
		// A store that can't be read or written is a broken service, not something the desk refuses: failures are defects.
		/** Every entry on disk, by `created`; unparseable files are skipped. */
		readonly load: Effect.Effect<ReadonlyArray<Entry>>;
		readonly write: (entry: Entry) => Effect.Effect<void>;
		readonly remove: (id: EntryId) => Effect.Effect<void>;
		/** Stores an attachment's bytes; returns its path below the root, `attachments/<uuid>.<ext>`. */
		readonly attach: (name: string, data: Uint8Array) => Effect.Effect<string>;
		/** Deletes attachments by their path below the root; missing ones are fine. */
		readonly detach: (files: Iterable<string>) => Effect.Effect<void>;
		/** An entry file was written, renamed or removed, by anyone. */
		readonly changed: Stream.Stream<void>;
	}
>()("desk/Store") {
	static layer(root: string) {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const io = Effect.orDie;
				const file = (id: EntryId) => path.join(root, fileName(id));

				yield* io(fs.makeDirectory(root, { recursive: true }));

				return Store.of({
					root,
					load: io(
						Effect.gen(function* () {
							const entries: Array<Entry> = [];
							for (const name of yield* fs.readDirectory(root)) {
								const id = idOf(name);
								if (id === undefined) continue;
								// Gone since the listing (removed meanwhile): not an entry anymore.
								const text = yield* Effect.orElseSucceed(fs.readFileString(file(id)), () => undefined);
								const entry = text === undefined ? undefined : Option.getOrUndefined(parse(id, text));
								if (entry) entries.push(entry);
							}
							// Same-millisecond entries in a fixed order, whatever order the directory lists them in.
							return entries.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
						}),
					),
					write: (entry) => {
						// Beside the file under a name that isn't an entry's, then over it in one step.
						const temp = path.join(root, `.${fileName(entry.id)}.${newId()}.tmp`);
						return io(Effect.andThen(fs.writeFileString(temp, serialize(entry)), fs.rename(temp, file(entry.id))));
					},
					remove: (id) => io(fs.remove(file(id), { force: true })),
					attach: (name, data) =>
						Effect.gen(function* () {
							const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
							const relative = `attachments/${newId()}.${extension}`;
							yield* io(fs.makeDirectory(path.join(root, "attachments"), { recursive: true }));
							yield* io(fs.writeFile(path.join(root, relative), data));
							return relative;
						}),
					detach: (files) => Effect.forEach([...files], (relative) => Effect.ignore(fs.remove(path.join(root, relative), { force: true })), { discard: true }),
					changed: fs.watch(root).pipe(
						Stream.orDie,
						Stream.filter((event) => idOf(path.basename(event.path)) !== undefined),
						Stream.map(() => undefined),
					),
				});
			}),
		);
	}
}
