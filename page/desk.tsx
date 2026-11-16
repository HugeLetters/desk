/** @jsxImportSource solid-js */
/**
 * What every view of the page shares: the desk shown (`session`, the route's: the shell reads it from the URL), its view
 * (`stores/view.ts`), the drafts (`stores/drafts.ts`) and their attachments (`stores/files.ts`), the toast, and what
 * the user does with them, through `useDesk`.
 */
import { type Accessor, createContext, createEffect, on, type ParentProps, useContext } from "solid-js";
import { reconcile } from "solid-js/store";
import type { View } from "../src/api/api";
import { deskPath } from "../src/api/routes";
import { type Entry, newId, waitingOn } from "../src/model/entry";
import type { Identity } from "../src/shared/type";
import * as Attachments from "./attachments";
import * as Rpc from "./rpc";
import { createDrafts } from "./stores/drafts";
import { createFiles } from "./stores/files";
import { createToast } from "./stores/toast";
import { createView } from "./stores/view";

/** Whether the entry waits on the user. */
export const yours = (entry: Entry) => waitingOn(entry) === "user";

/** `session`: the desk the route shows, none on the list of desks. */
export const createDesk = (session: Accessor<string | undefined>) => {
	const toast = createToast();
	const drafts = createDrafts(session);
	const files = createFiles(drafts);

	/** A draft for an entry that left the desk can't be sent anymore. */
	const dropGone = (view: View) => {
		const gone = Object.keys(drafts.drafts).filter((entry) => !view.entries.some((other) => other.id === entry));
		for (const entry of gone) drafts.setDrafts(entry, undefined);
		if (gone.length > 0) void files.loaded.then(files.prune);
	};

	const view = createView(session, dropGone);

	// The drafts may load after the desk's first view.
	createEffect(
		on(drafts.loaded, (loaded) => {
			const now = view.state.view;
			if (loaded && now && (now.desk?.session ?? undefined) === session()) dropGone(now);
		}),
	);

	/** The desk's list of entries, or the list of desks. */
	const home = () => {
		const id = session();
		return id === undefined ? "/" : deskPath(id);
	};

	/** Waiting on you, and you've started an answer: shown instead of the plain status. */
	const drafted = (entry: Entry) => yours(entry) && !!drafts.drafts[entry.id]?.trim();

	/** Keeps the files with the draft and inserts their Markdown at `at` (default: the end); they're uploaded when it's sent. */
	const attach = (entry: string, added: ReadonlyArray<File>, at?: number) =>
		toast.attempt(async () => {
			await files.loaded;
			const stored = added.map(
				(file): Attachments.Local => ({ id: newId(), name: file.name || "file", type: file.type, blob: file }),
			);
			await Promise.all(stored.map(Attachments.save));
			stored.forEach(files.keep);

			const markdown = stored.map(Attachments.link).join("\n");
			const text = drafts.drafts[entry] ?? "";
			const index = Math.min(at ?? text.length, text.length);
			const before = text.slice(0, index);
			drafts.setDrafts(
				entry,
				`${before}${before && !before.endsWith("\n") ? "\n" : ""}${markdown}\n${text.slice(index)}`,
			);
			return `Attached ${added.length} file${added.length === 1 ? "" : "s"}`;
		});

	/** Every draft, one queued message per session. */
	const submit = () =>
		toast.attempt(async () => {
			const sent = await Promise.all(drafts.pending().map(files.outgoing));
			const count = await Rpc.call((client) => client.submit({ drafts: sent }));
			drafts.setDrafts(reconcile({}));
			await files.prune();
			return `Submitted ${count} draft${count === 1 ? "" : "s"}; queued for the agents`;
		});

	/** One draft, steering its session's current turn. */
	const sendNow = (entry: Entry) => {
		const draft = { entry: entry.id, text: drafts.drafts[entry.id] ?? "" };
		return toast.attempt(async () => {
			const sent = await files.outgoing(draft);
			await Rpc.call((client) => client.send(sent));
			drafts.setDrafts(draft.entry, undefined);
			await files.prune();
			return "Sent to the agents";
		});
	};

	return { session, home, view, drafts, files, toast, drafted, attach, submit, sendNow };
};

export interface Desk extends Identity<ReturnType<typeof createDesk>> {}

const DeskContext = createContext<Desk>();

export const DeskProvider = (props: ParentProps<{ desk: Desk }>) => (
	<DeskContext.Provider value={props.desk}>{props.children}</DeskContext.Provider>
);

/** The page's desk, from `DeskProvider`. */
export const useDesk = () => {
	const desk = useContext(DeskContext);
	if (!desk) throw new Error("useDesk outside DeskProvider");

	return desk;
};
