/**
 * Ids (and directories) for fixtures. The real ones are parsed where they come in (`EntryId` is a UUID); tests take
 * readable ones, like "parent", and mark them with these, as the parsing would.
 */
import type { ProjectID } from "@opencode/schema/project-id";
import type { EntryId, MessageID, SessionID } from "../../src/model/entry";
import { AbsolutePath, RelativePath } from "../../src/model/paths";

export const E = (id: string) => id as EntryId;
export const S = (id: string) => id as SessionID;
export const M = (id: string) => id as MessageID;
export const P = (id: string) => id as ProjectID;
/** A directory, checked as the parsing would: absolute. */
export const D = (path: string) => AbsolutePath.make(path);
/** A path below a directory, checked as the parsing would: never climbing out of it. */
export const R = (path: string) => RelativePath.make(path);
