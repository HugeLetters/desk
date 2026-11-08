/**
 * The store: one flat directory (`~/.local/share/desk/`, or `$DESK_HOME`) of `<entry id>.md` files, and the
 * attachments the user sent, in `attachments/`. Other files there (the service's socket, its log, the project cache)
 * aren't entries.
 *
 * It remembers what it wrote, so `edits` reports only changes made by someone else (an editor, `git checkout`, a
 * second machine syncing the folder), each as the entry now on disk or `null` once its file is gone. A watch event
 * may arrive late and read a file between two of our writes, so anything we ever wrote to a file counts as ours.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { DeskError } from "./errors";
import { type Entry, fileName, idOf, newId, parse, serialize } from "./entry";

export interface Edit {
	readonly id: string;
	readonly entry: Entry | null;
}

export class Store extends Context.Service<
	Store,
	{
		readonly root: string;
		/** Every entry on disk; unparseable files are skipped. */
		readonly load: Effect.Effect<ReadonlyArray<Entry>, DeskError>;
		readonly write: (entry: Entry) => Effect.Effect<void, DeskError>;
		readonly remove: (id: string) => Effect.Effect<void, DeskError>;
		/** Stores an attachment's bytes; returns its path below the root, `attachments/<uuid>.<ext>`. */
		readonly attach: (name: string, data: Uint8Array) => Effect.Effect<string, DeskError>;
		/** Deletes attachments by their path below the root; missing ones are fine. */
		readonly detach: (files: Iterable<string>) => Effect.Effect<void>;
		/** Changes to entry files that this store didn't make. */
		readonly edits: Stream.Stream<Edit>;
	}
>()("desk/Store") {
	static layer(root: string) {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const io = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError((cause) => new DeskError({ message: String(cause) })));
				const file = (id: string) => path.join(root, fileName(id));
				/** Everything we wrote to each file (`null`: we removed it), and what an edit last left there. */
				const written = new Map<string, Set<string | null>>();
				const ours = (id: string, text: string | null) => written.get(id)?.has(text) ?? false;
				const remember = (id: string, text: string | null) => {
					const texts = written.get(id) ?? new Set();
					written.set(id, texts.add(text));
				};

				yield* io(fs.makeDirectory(root, { recursive: true }));

				const read = (id: string) =>
					fs.readFileString(file(id)).pipe(
						Effect.map((text) => ({ text, entry: Option.getOrNull(parse(id, text)) })),
						Effect.orElseSucceed(() => ({ text: null, entry: null })),
					);

				return Store.of({
					root,
					load: io(
						Effect.gen(function* () {
							const entries: Array<Entry> = [];
							for (const name of yield* fs.readDirectory(root)) {
								const id = idOf(name);
								if (id === undefined) continue;
								const { text, entry } = yield* read(id);
								remember(id, text);
								if (entry) entries.push(entry);
							}
							return entries.sort((a, b) => a.created.localeCompare(b.created));
						}),
					),
					write: (entry) => {
						const text = serialize(entry);
						remember(entry.id, text);
						return io(fs.writeFileString(file(entry.id), text));
					},
					remove: (id) => {
						remember(id, null);
						return io(fs.remove(file(id), { force: true }));
					},
					attach: (name, data) =>
						Effect.gen(function* () {
							const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
							const relative = `attachments/${newId()}.${extension}`;
							yield* io(fs.makeDirectory(path.join(root, "attachments"), { recursive: true }));
							yield* io(fs.writeFile(path.join(root, relative), data));
							return relative;
						}),
					detach: (files) => Effect.forEach([...files], (relative) => Effect.ignore(fs.remove(path.join(root, relative), { force: true })), { discard: true }),
					edits: fs.watch(root).pipe(
						Stream.orDie,
						Stream.map((event) => idOf(path.basename(event.path))),
						Stream.filter((id): id is string => id !== undefined),
						Stream.mapEffect((id) =>
							Effect.map(read(id), ({ text, entry }): Edit | undefined => {
								// Ours, or half-written: nothing to take in yet.
								if (ours(id, text) || (text !== null && entry === null)) return undefined;
								remember(id, text);
								return { id, entry };
							}),
						),
						Stream.filter((edit): edit is Edit => edit !== undefined),
					),
				});
			}),
		);
	}
}
