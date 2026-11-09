/** Where an entry is shown (`projects.ts` works it out), shared with the page. */
import { ProjectID } from "@opencode/schema/project-id";
import * as Schema from "effect/Schema";

/** Where an entry is shown: its session's project, or, while no connected OpenCode knows the session, its folder. */
export const Placement = Schema.TaggedUnion({
	Project: { id: ProjectID },
	Folder: { directory: Schema.String },
});
export type Placement = typeof Placement.Type;

const folderPrefix = "folder:";

/** A placement as one string: the page's URLs (`/projects/<key>`) and the view's `project`. */
export const key = (placement: Placement): string =>
	placement._tag === "Project" ? placement.id : `${folderPrefix}${placement.directory}`;
/** The placement a key names. */
export const fromKey = (key: string): Placement =>
	key.startsWith(folderPrefix)
		? { _tag: "Folder", directory: key.slice(folderPrefix.length) }
		: { _tag: "Project", id: key as ProjectID };
