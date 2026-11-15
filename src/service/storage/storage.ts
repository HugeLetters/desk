/**
 * Storage: the only way the service reaches the store, and the only part of it that knows the store is files. It runs
 * over a {@link Backend}, of which there are two: the files (`Backend.files`, `files.ts`), and memory (`Backend.memory`,
 * `memory.ts`) for tests that are about the desk's rules, not about files. `Storage.layer` and `Storage.layerMemory`
 * are each one with its backend; a test can give `Storage.layerFromBackend` a backend of its own (one that fails, say).
 *
 * What it keeps out of the rest of the service: changes run one at a time (`transact`, a lock), so the desk decides on
 * the entries as they are and nothing writes in between; `changes` says when to read again, whoever changed what;
 * attachments a failed change stored go with it; and nothing is read outside where it may be (an attachment outside
 * `attachments/`; a file outside an entry's directory can't be named: a `RelativePath` doesn't climb out).
 */
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { type Entry, type EntryId, newId } from "../../model/entry";
import { AbsolutePath, RelativePath } from "../../model/paths";
import { files } from "./files";
import { memory } from "./memory";
import type { Info, Where } from "./registration";

type Entries = ReadonlyArray<Entry>;

/** A stored file, to send: its bytes (from disk, read as they're sent) and when it last changed (ms). */
export interface Content {
	readonly data: Blob;
	readonly modified: number;
}

/** What a change may do to the store, within `transact`. */
export interface Transaction {
	readonly write: (entry: Entry) => Effect.Effect<void>;
	readonly remove: (id: EntryId) => Effect.Effect<void>;
	/**
	 * Stores an attachment's bytes; returns its path below the store, `attachments/<uuid>.<ext>`. If the change fails,
	 * it goes again: a failed change leaves no attachments behind.
	 */
	readonly attach: (name: string, data: Uint8Array) => Effect.Effect<RelativePath>;
	/** Deletes attachments by their path below the store; missing ones are fine. */
	readonly detach: (files: Iterable<RelativePath>) => Effect.Effect<void>;
}

/**
 * What an implementation does, with no rules of its own: `make` adds the lock, the change signal and the checks on
 * where a read may go. A store that can't be read or written is a broken service, not something the desk refuses:
 * failures are defects.
 */
export class Backend extends Context.Service<
	Backend,
	{
		/** Every entry, by `created` then id; unparseable ones are skipped. */
		readonly load: Effect.Effect<Entries>;
		readonly write: (entry: Entry) => Effect.Effect<void>;
		readonly remove: (id: EntryId) => Effect.Effect<void>;
		/** Stores an attachment at `file`, its path below the store (`attachments/<uuid>.<ext>`). */
		readonly attach: (file: RelativePath, data: Uint8Array) => Effect.Effect<void>;
		readonly detach: (files: Iterable<RelativePath>) => Effect.Effect<void>;
		/** An attachment by its path below the store (already checked to be in `attachments/`); none when it's missing. */
		readonly attachment: (file: RelativePath) => Effect.Effect<Option.Option<Content>>;
		/** Where the session reads an attachment from. */
		readonly attachmentUrl: (file: RelativePath) => Effect.Effect<URL>;
		/** A file by its absolute path (in its entry's directory); none when it's missing. */
		readonly file: (path: AbsolutePath) => Effect.Effect<Option.Option<Content>>;
		/** Something may have changed without a transaction (someone else's edit): read again. */
		readonly changed: Stream.Stream<void>;
		readonly publish: (where: Where) => Effect.Effect<void>;
		/** The registration now; none when there's none (or it isn't one). */
		readonly registration: Effect.Effect<Option.Option<Info>>;
	}
>()("desk/Storage/Backend") {
	/**
	 * The files of the store the settings name (`Settings.files`). Takes the store's lock (`registration.ts`) for the
	 * layer's lifetime first, or fails with `AlreadyRunning`.
	 * @param rescan How often to read again regardless, should a file event get lost.
	 */
	static files(rescan: Duration.Input = "5 seconds") {
		return Layer.effect(Backend, files(rescan));
	}

	/** A store in memory, empty but for `files` (by absolute path) to read as if they were in entries' directories. */
	static memory(files: Readonly<Record<AbsolutePath, string | Uint8Array>> = {}) {
		return Layer.effect(Backend, memory(files));
	}
}

export class Storage extends Context.Service<
	Storage,
	{
		/** Every entry now, by `created` then id. */
		readonly entries: Effect.Effect<Entries>;
		/**
		 * One change: `change` gets the entries as they are and decides, writing through the transaction. Changes run one
		 * at a time, and `changes` fires after each, whether it succeeded or not.
		 */
		readonly transact: <A, E>(
			change: (entries: Entries, store: Transaction) => Effect.Effect<A, E>,
		) => Effect.Effect<A, E>;
		/** Something may have changed: read again. Once at the start, then after every transaction and every outside edit. */
		readonly changes: Stream.Stream<void>;
		/**
		 * An attachment by its path below the store, `attachments/<file>` (as entries link it); none when there's none,
		 * or when the path isn't directly in `attachments/`.
		 */
		readonly attachment: (file: RelativePath) => Effect.Effect<Option.Option<Content>>;
		/** Where the session reads an attachment from: a URL it can open (a `file:` URL, on disk). */
		readonly attachmentUrl: (file: RelativePath) => Effect.Effect<URL>;
		/** A file below `directory` (an entry's; a relative path never leaves it); none when it's missing. */
		readonly file: (directory: AbsolutePath, below: RelativePath) => Effect.Effect<Option.Option<Content>>;
		/** Records where the page is, once it's up (in the registration, on disk). */
		readonly publish: (where: Where) => Effect.Effect<void>;
		/** The store's registration now (`registration.ts`): this service's, while it holds the store. */
		readonly registration: Effect.Effect<Option.Option<Info>>;
	}
>()("desk/Storage") {
	/** Storage over the {@link Backend} provided. */
	static get layerFromBackend() {
		return Layer.effect(Storage, make());
	}

	/** Storage over the files of the store the settings name ({@link Backend.files}). */
	static layer(rescan?: Duration.Input) {
		return Storage.layerFromBackend.pipe(Layer.provide(Backend.files(rescan)));
	}

	/** Storage over a store in memory ({@link Backend.memory}). */
	static layerMemory(options: { readonly files?: Readonly<Record<AbsolutePath, string | Uint8Array>> } = {}) {
		return Storage.layerFromBackend.pipe(Layer.provide(Backend.memory(options.files)), Layer.provide(Path.layer));
	}
}

/** Storage over the {@link Backend}: the lock, the change signal and the checks on where a read may go. */
export const make = Effect.fn("Storage.make")(function* () {
	const backend = yield* Backend;
	const path = yield* Path.Path;
	const lock = yield* Semaphore.make(1);
	const transacted = yield* PubSub.unbounded<void>();

	/** The transaction's handle: what it attached is kept, to go again if the change fails. */
	const handle = (attached: Ref.Ref<ReadonlyArray<RelativePath>>): Transaction => ({
		write: backend.write,
		remove: backend.remove,
		attach: (name, data) => {
			const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
			const file = RelativePath.make(`attachments/${newId()}.${extension}`);
			return backend
				.attach(file, data)
				.pipe(Effect.andThen(Ref.update(attached, (files) => [...files, file])), Effect.as(file));
		},
		detach: backend.detach,
	});

	/** Only what's directly in `attachments/`. */
	const attachment = (file: RelativePath) => {
		const normal = RelativePath.make(path.normalize(file));
		return path.dirname(normal) === "attachments" ? backend.attachment(normal) : Effect.succeedNone;
	};

	return Storage.of({
		entries: backend.load,
		transact: (change) =>
			lock
				.withPermits(1)(
					Effect.gen(function* () {
						const attached = yield* Ref.make<ReadonlyArray<RelativePath>>([]);
						const all = yield* backend.load;
						return yield* change(all, handle(attached)).pipe(
							Effect.onError(() => Effect.flatMap(Ref.get(attached), backend.detach)),
						);
					}),
				)
				.pipe(Effect.ensuring(PubSub.publish(transacted, undefined))),
		// Subscribed before the first signal, so a transaction right after it is never missed.
		changes: Stream.unwrap(
			Effect.map(PubSub.subscribe(transacted), (subscription) =>
				Stream.concat(
					Stream.make(undefined),
					Stream.mergeAll([Stream.fromSubscription(subscription), backend.changed], { concurrency: "unbounded" }),
				),
			),
		),
		attachment,
		attachmentUrl: backend.attachmentUrl,
		file: (directory, below) => backend.file(AbsolutePath.make(path.join(directory, below))),
		publish: backend.publish,
		registration: backend.registration,
	});
});
