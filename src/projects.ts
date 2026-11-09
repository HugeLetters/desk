/**
 * Which project an entry belongs to. Entries don't store it: it's their root session's project, asked of OpenCode
 * (`session.get(root).projectID`, through a connected plugin instance) and remembered in memory only, kept while
 * OpenCode is away. A session that moves is asked again, and so is every session whenever a plugin instance connects,
 * so a move missed while nothing was connected is caught on the next connect. One nobody connected knows keeps what
 * was known; one that couldn't be asked (a plugin didn't answer) is asked again next time.
 *
 * When no connected OpenCode knows the session, the entry is placed by its folder instead (`Folder`): a guess, shown
 * as one, until an OpenCode that knows it connects.
 *
 * A project's name is the last segment of its directory, as plugin instances report it when they connect (else the
 * directory of a session in it).
 */
import type { ProjectID } from "@opencode/schema/project-id";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { SessionID } from "./entry";
import { OpenCode } from "./opencode";
import type { Placement } from "./placement";

export { fromKey, key, Placement } from "./placement";

/** What's known, in one state. */
interface State {
	/** Root session → its project, or null: no connected OpenCode knew it. */
	readonly sessions: ReadonlyMap<SessionID, ProjectID | null>;
	/** Sessions to ask again (a connect, a move, a lookup that couldn't be made) before their remembered project is used. */
	readonly stale: ReadonlySet<SessionID>;
	/** Project → its directory, for its name. */
	readonly directories: ReadonlyMap<ProjectID, string>;
}

export class Projects extends Context.Service<
	Projects,
	{
		/** Where an entry's root session's entries go. */
		readonly of: (entry: { readonly session: SessionID; readonly directory: string }) => Effect.Effect<Placement>;
		/** Records a project's directory (for its name). */
		readonly remember: (project: ProjectID, directory: string) => Effect.Effect<void>;
		readonly name: (placement: Placement, fallbackDirectory?: string) => Effect.Effect<string>;
		/** Whenever a session's project may have changed or a name was learned. */
		readonly changes: Stream.Stream<void>;
	}
>()("desk/Projects") {
	static get layer() {
		return Layer.effect(
			Projects,
			Effect.gen(function* () {
				const opencode = yield* OpenCode;
				const path = yield* Path.Path;
				const state = yield* SubscriptionRef.make<State>({
					sessions: new Map(),
					stale: new Set(),
					directories: new Map(),
				});
				const staleAll = (pick: (now: State) => Iterable<SessionID>) =>
					SubscriptionRef.update(state, (now) => ({ ...now, stale: new Set([...now.stale, ...pick(now)]) }));

				yield* opencode.moved.pipe(
					Stream.runForEach((session) => staleAll(() => [session])),
					Effect.forkScoped,
				);
				yield* opencode.joined.pipe(
					Stream.runForEach(() => staleAll((now) => now.sessions.keys())),
					Effect.forkScoped,
				);

				const placed = (project: ProjectID | null | undefined, directory: string): Placement =>
					project ? { _tag: "Project", id: project } : { _tag: "Folder", directory };

				return Projects.of({
					of: ({ session, directory }) =>
						Effect.gen(function* () {
							const now = yield* SubscriptionRef.get(state);
							const known = now.sessions.get(session);
							if (known !== undefined && !now.stale.has(session)) return placed(known, directory);
							const lookup = yield* opencode.session(session);
							const project = lookup._tag === "Known" ? lookup.session.projectID : (known ?? null);
							yield* SubscriptionRef.update(state, (now) => {
								const stale = new Set(now.stale);
								// Couldn't be asked: what was known stands, and it's asked again next time.
								if (lookup._tag === "Unreachable") stale.add(session);
								else stale.delete(session);
								const directories = new Map(now.directories);
								// A name for a project no plugin instance has reported yet: the session's folder.
								if (lookup._tag === "Known" && !directories.has(lookup.session.projectID))
									directories.set(lookup.session.projectID, lookup.session.directory);
								return { sessions: new Map(now.sessions).set(session, project), stale, directories };
							});
							return placed(project, directory);
						}),
					remember: (project, directory) =>
						SubscriptionRef.update(state, (now) =>
							now.directories.get(project) === directory
								? now
								: { ...now, directories: new Map(now.directories).set(project, directory) },
						),
					name: (placement, fallbackDirectory) =>
						Effect.map(SubscriptionRef.get(state), (now) =>
							path.basename(
								placement._tag === "Folder"
									? placement.directory
									: (now.directories.get(placement.id) ?? fallbackDirectory ?? placement.id),
							),
						),
					// News: a project or a name changed, or a session is to be asked again. `of` remembering what it was just
					// told isn't, or every view would be worked out twice.
					changes: SubscriptionRef.changes(state).pipe(
						Stream.changesWith(
							(before, after) =>
								same(before.sessions, after.sessions) &&
								same(before.directories, after.directories) &&
								[...after.stale].every((session) => before.stale.has(session)),
						),
						Stream.as(undefined),
					),
				});
			}),
		);
	}
}

const same = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
	a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
