/**
 * Which project an entry belongs to. Entries don't store it: it's their root session's project, asked of OpenCode
 * (`session.get(root).projectID`) the first time and cached, in memory and in `<store>/projects.json` (so the page
 * still sorts entries while no OpenCode is running). A session that moves is dropped from the cache and asked again,
 * so its entries follow it to the new project.
 *
 * A project's name is the last segment of its directory, as plugin instances report it when they connect (else the
 * directory of an entry in it).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { OpenCode } from "./opencode";

export interface Project {
	readonly id: string;
	readonly name: string;
}

interface Cache {
	/** Root session → project id. */
	readonly sessions: Record<string, string>;
	/** Project id → its directory. */
	readonly directories: Record<string, string>;
}

export class Projects extends Context.Service<
	Projects,
	{
		/** The project of a root session; undefined while no OpenCode that knows it is connected and it isn't cached. */
		readonly of: (session: string) => Effect.Effect<string | undefined>;
		/** Records a project's directory (for its name). */
		readonly remember: (project: string, directory: string) => Effect.Effect<void>;
		readonly name: (project: string, fallbackDirectory?: string) => Effect.Effect<string>;
		/** A version number, bumped whenever a session's project may have changed or a name was learned. */
		readonly changes: Stream.Stream<number>;
	}
>()("desk/Projects") {
	static layer(root: string) {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const opencode = yield* OpenCode;
				const file = path.join(root, "projects.json");
				const loaded = yield* fs.readFileString(file).pipe(
					Effect.map((text) => JSON.parse(text) as Cache),
					Effect.orElseSucceed((): Cache => ({ sessions: {}, directories: {} })),
				);
				const cache = { sessions: { ...loaded.sessions }, directories: { ...loaded.directories } };
				const version = yield* SubscriptionRef.make(0);
				const save = Effect.andThen(Effect.ignore(fs.writeFileString(file, JSON.stringify(cache, null, "\t"))), SubscriptionRef.update(version, (n) => n + 1));

				yield* opencode.moved.pipe(
					Stream.runForEach((session) => {
						if (!(session in cache.sessions)) return Effect.void;
						delete cache.sessions[session];
						return save;
					}),
					Effect.forkScoped,
				);
				// A server that comes back may know sessions we couldn't place: have the views ask again.
				yield* opencode.attached.pipe(
					Stream.runForEach(() => SubscriptionRef.update(version, (n) => n + 1)),
					Effect.forkScoped,
				);

				return Projects.of({
					of: (session) =>
						Effect.suspend(() => {
							const known = cache.sessions[session];
							if (known) return Effect.succeed(known);
							return Effect.flatMap(opencode.session(session), (info) => {
								if (!info) return Effect.succeed(undefined);
								cache.sessions[session] = info.projectID;
								return Effect.as(save, info.projectID);
							});
						}),
					remember: (project, directory) =>
						Effect.suspend(() => {
							if (cache.directories[project] === directory) return Effect.void;
							cache.directories[project] = directory;
							return save;
						}),
					name: (project, fallbackDirectory) => Effect.sync(() => path.basename(cache.directories[project] ?? fallbackDirectory ?? project)),
					changes: SubscriptionRef.changes(version),
				});
			}),
		);
	}
}
