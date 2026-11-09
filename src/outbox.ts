/**
 * What waits to reach the sessions: the entries carrying an outbox, as one message per outbox. Rebuilt from the
 * entries each time, so a retry sends the same text under the same message id.
 */
import { attachmentsIn, type Delivery, type Entry } from "./entry";

export interface Message {
	/** The OpenCode message id: OpenCode admits a message id once, however often it's sent. */
	readonly id: string;
	readonly session: string;
	readonly delivery: Delivery;
	readonly text: string;
	/** Attachments by their path below the store, with the name the user gave them. */
	readonly files: ReadonlyArray<{ readonly file: string; readonly name: string }>;
}

export function messages(entries: ReadonlyArray<Entry>): Array<Message> {
	const byOutbox = new Map<string, Array<Entry>>();
	for (const entry of entries) if (entry.outbox !== null) byOutbox.set(entry.outbox, [...(byOutbox.get(entry.outbox) ?? []), entry]);
	return [...byOutbox].map(([id, sent]) => {
		const sections = sent.map((entry) =>
			entry.asker === "agent"
				? { text: `## ${entry.id} Answered: ${entry.title}\n\n${entry.answer ?? ""}`, body: entry.answer ?? "" }
				: { text: `## ${entry.id} New question from the user${entry.parent === null ? "" : ` (follow-up to ${entry.parent})`}\n\n${entry.question}`, body: entry.question },
		);
		return {
			id,
			session: sent[0]!.session,
			delivery: sent.some((entry) => entry.delivery === "steer") ? "steer" : "queue",
			text: [
				"Desk: the user replied on the desk.",
				// What to do with it is in the desk_* tools' descriptions; repeating it in every message only fills the context.
				...sections.map((section) => section.text),
			].join("\n\n"),
			files: sections.flatMap((section) => attachmentsIn(section.body)),
		};
	});
}
