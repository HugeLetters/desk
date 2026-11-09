/**
 * Which project an entry belongs to. Entries don't store it: it's their root session's project, asked of OpenCode
 * (`session.get(root).projectID`, through a connected plugin instance) and remembered in memory only, kept while
 * OpenCode is away. A session that moves is asked again, and so is every session whenever a plugin instance connects,
 * so a move missed while nothing was connected is caught on the next connect; one nobody connected knows keeps what
 * was known.
 *
 * When no connected OpenCode knows the session, the entry is placed by its folder instead (`folder:<directory>`): a
 * guess, shown as one, until an OpenCode that knows it connects.
 *
 * A project's name is the last segment of its directory, as plugin instances report it when they connect (else the
 * directory of an entry in it).
 */
import { basename } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { OpenCode } from "./opencode";

const folderPrefix = "folder:";

/** The id an entry gets while no connected OpenCode can place it: its folder. */
export const folder = (directory: string) => `${folderPrefix}${directory}`;
/** Whether a project id is a folder guess rather than OpenCode's project. */
export const guessed = (project: string) => project.startsWith(folderPrefix);

export class Projects extends Context.Service<
	Projects,
	{
		/** The project of an entry's root session, or its folder when no connected OpenCode knows the session. */
		readonly of: (entry: { readonly session: string; readonly directory: string }) => Effect.Effect<string>;
		/** Records a project's directory (for its name). */
		readonly remember: (project: string, directory: string) => Effect.Effect<void>;
		readonly name: (project: string, fallbackDirectory?: string) => Effect.Effect<string>;
		/** A version number, bumped whenever a session's project may have changed or a name was learned. */
		readonly changes: Stream.Stream<number>;
	}
>()("desk/Projects") {
	static get layer() {
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const opencode = yield* OpenCode;
				/** Root session → its project, or null: no connected OpenCode knew it. */
				const sessions = new Map<string, string | null>();
				/** Sessions to ask again (a connect, a move) before their remembered project is used. */
				const stale = new Set<string>();
				/** Project id → its directory. */
				const directories = new Map<string, string>();
				const version = yield* SubscriptionRef.make(0);
				const bump = SubscriptionRef.update(version, (n) => n + 1);

				yield* opencode.moved.pipe(
					Stream.runForEach((session) => Effect.andThen(Effect.sync(() => stale.add(session)), bump)),
					Effect.forkScoped,
				);
				// A plugin instance that connects may know sessions, or moves, the others didn't: ask again.
				let previous = 0;
				yield* opencode.attached.pipe(
					Stream.runForEach((count) => {
						const more = count > previous;
						previous = count;
						if (more) for (const session of sessions.keys()) stale.add(session);
						return bump;
					}),
					Effect.forkScoped,
				);

				return Projects.of({
					of: ({ session, directory }) =>
						Effect.suspend(() => {
							const known = sessions.get(session);
							if (known !== undefined && !stale.has(session)) return Effect.succeed(known ?? folder(directory));
							stale.delete(session);
							return Effect.map(opencode.session(session), (info) => {
								const project = info?.projectID ?? known ?? null;
								sessions.set(session, project);
								// A name for a project no plugin instance has reported yet: the session's folder.
								if (info && !directories.has(info.projectID)) directories.set(info.projectID, info.directory);
								return project ?? folder(directory);
							});
						}),
					remember: (project, directory) =>
						Effect.suspend(() => {
							if (directories.get(project) === directory) return Effect.void;
							directories.set(project, directory);
							return bump;
						}),
					name: (project, fallbackDirectory) =>
						Effect.sync(() => basename(guessed(project) ? project.slice(folderPrefix.length) : (directories.get(project) ?? fallbackDirectory ?? project))),
					changes: SubscriptionRef.changes(version),
				});
			}),
		);
	}
}
