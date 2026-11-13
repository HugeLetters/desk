/**
 * The store on disk: one flat directory (`~/.local/share/desk/`, or `$DESK_HOME`) of `<entry id>.md` files, and the
 * attachments the user sent, in `attachments/`. Other files there (the service's socket, log and registration) aren't
 * entries.
 *
 * The files are the desk's only state: nothing here remembers entries between reads. `load` reads them all each time.
 * A write lands whole (written beside the file, then renamed over it), so a read never sees half an entry. `changed`
 * fires on any entry file event (ours included) and every `rescan`, in case an event gets lost.
 */

import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { type EntryId, fileName, idOf, newId, parse, serialize } from "../../model/entry";
import { register } from "./registration";
import type { Backend, Content } from "./storage";

export const files = (root: string, rescan: Duration.Input) =>
	Effect.gen(function* () {
		// The lock first: nothing else touches the store while another service has it.
		const { publish } = yield* register(root);
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const io = Effect.orDie;
		const file = (id: EntryId) => path.join(root, fileName(id));
		/** A file to send, read as it's sent (Bun reads it, ranges and all); none when it isn't a file. */
		const content = (at: string) =>
			fs.stat(at).pipe(
				Effect.option,
				Effect.map(
					Option.flatMap(
						(info): Option.Option<Content> =>
							info.type === "File"
								? Option.some({
										data: Bun.file(at),
										modified: Option.getOrElse(
											Option.map(info.mtime, (mtime) => mtime.getTime()),
											() => 0,
										),
									})
								: Option.none(),
					),
				),
			);

		yield* io(fs.makeDirectory(root, { recursive: true }));

		const backend: Backend = {
			load: io(
				Effect.gen(function* () {
					const ids = (yield* fs.readDirectory(root)).flatMap((name) => {
						const id = idOf(name);
						return id === undefined ? [] : [id];
					});
					const read = yield* Effect.forEach(ids, (id) =>
						fs.readFileString(file(id)).pipe(
							// Gone since the listing (removed meanwhile): not an entry anymore.
							Effect.option,
							Effect.map(Option.flatMap((text) => parse(id, text))),
						),
					);
					// Same-millisecond entries in a fixed order, whatever order the directory lists them in.
					return read
						.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
						.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
				}),
			),
			write: (entry) => {
				// Beside the file under a name that isn't an entry's, then over it in one step.
				const temp = path.join(root, `.${fileName(entry.id)}.${newId()}.tmp`);
				return io(Effect.andThen(fs.writeFileString(temp, serialize(entry)), fs.rename(temp, file(entry.id))));
			},
			remove: (id) => io(fs.remove(file(id), { force: true })),
			attach: (relative, data) =>
				io(
					Effect.andThen(
						fs.makeDirectory(path.join(root, "attachments"), { recursive: true }),
						fs.writeFile(path.join(root, relative), data),
					),
				),
			detach: (files) =>
				Effect.forEach([...files], (relative) => Effect.ignore(fs.remove(path.join(root, relative), { force: true })), {
					discard: true,
				}),
			attachment: (relative) => content(path.join(root, relative)),
			// A path below the store always makes a file URL.
			attachmentUrl: (relative) => Effect.map(io(path.toFileUrl(path.join(root, relative))), (url) => url.href),
			changed: Stream.merge(
				fs.watch(root).pipe(
					Stream.orDie,
					Stream.filter((event) => idOf(path.basename(event.path)) !== undefined),
					Stream.map(() => undefined),
				),
				Stream.tick(rescan),
			),
			publish,
		};
		return backend;
	});
