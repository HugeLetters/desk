/**
 * What waits to reach the sessions: the entries with pending text, as one message per pending message. Rebuilt from the
 * entries each time, so a retry sends the same text under the same message id.
 */
import { attachmentsIn, type Delivery, type Entry, type MessageID, type SessionID } from "./entry";

export interface Message {
	/** The OpenCode message id: OpenCode admits a message id once, however often it's sent. */
	readonly id: MessageID;
	readonly session: SessionID;
	readonly delivery: Delivery;
	readonly text: string;
	/** Attachments by their path below the store, with the name the user gave them. */
	readonly files: ReadonlyArray<{ readonly file: string; readonly name: string }>;
}

/**
 * The messages to send now: those whose session is in desk mode. Out of it, the session has no desk tools to reply
 * with, so its messages wait as they do for a session no connected OpenCode knows.
 */
export const due = (entries: ReadonlyArray<Entry>, deskMode: ReadonlySet<SessionID>): Array<Message> => messages(entries).filter((message) => deskMode.has(message.session));

export function messages(entries: ReadonlyArray<Entry>): Array<Message> {
	const byMessage = new Map<MessageID, Array<Entry>>();
	for (const entry of entries) if (entry.pending !== null) byMessage.set(entry.pending.message, [...(byMessage.get(entry.pending.message) ?? []), entry]);
	return [...byMessage].map(([id, sent]) => {
		const sections = sent.map((entry) =>
			entry.asker === "agent"
				? { text: `## ${entry.id} Answered: ${entry.title}\n\n${entry.answer ?? ""}`, body: entry.answer ?? "" }
				: { text: `## ${entry.id} New question from the user${entry.parent === null ? "" : ` (follow-up to ${entry.parent})`}\n\n${entry.question}`, body: entry.question },
		);
		return {
			id,
			session: sent[0]!.session,
			delivery: sent.some((entry) => entry.pending?.delivery === "steer") ? "steer" : "queue",
			text: [
				// Where the reply goes, said where the agent decides it: elsewhere, it would answer in chat. The rest is in the
				// desk_* tools' descriptions.
				"Desk: the user replied on the desk. Reply there too: a follow-up under the entry (desk_ask with its id as parent), or desk_answer for a question of theirs. In chat, name it by its title at most.",
				...sections.map((section) => section.text),
			].join("\n\n"),
			files: sections.flatMap((section) => attachmentsIn(section.body)),
		};
	});
}
