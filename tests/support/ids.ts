/**
 * Ids for fixtures. The real ones are parsed where they come in (`EntryId` is a UUID); tests take readable ones, like
 * "parent", and mark them with these, as the parsing would.
 */
import type { ProjectID } from "@opencode/schema/project-id";
import type { EntryId, MessageID, SessionID } from "../../src/entry";

export const E = (id: string) => id as EntryId;
export const S = (id: string) => id as SessionID;
export const M = (id: string) => id as MessageID;
export const P = (id: string) => id as ProjectID;
