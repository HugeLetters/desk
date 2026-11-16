/** How desks are named. */
import type { DeskName } from "../src/api/api";

/** How a desk is shown: its session's title and folder. */
export const deskName = (desk: DeskName | null | undefined) =>
	!desk ? "" : desk.title === desk.folder ? desk.title : `${desk.title} · ${desk.folder}`;
