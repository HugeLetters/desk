/** The words for what the desk refuses and why a delivery failed: shared by the page (toasts, pills) and the plugin (the agent's tool errors). */
import type { DeliveryFailed, Refusal } from "./errors";

export const refusal = (refused: Refusal): string => {
	switch (refused._tag) {
		case "NoSuchEntry":
			return `No desk entry ${refused.id}.`;
		case "HasParent":
			return `Entry ${refused.id} already has a parent (${refused.parent}); a parent never changes.`;
		case "WouldCycle":
			return `Entry ${refused.parent} is in the subtree of ${refused.id}; adopting it there would make a cycle.`;
		case "NotTheAnswerer":
			return `Entry ${refused.id} is the ${refused.by === "agent" ? "agents'" : "user's"} own question; the ${refused.by === "agent" ? "user answers" : "agents answer"} it.`;
		case "NotTheAsker":
			return `Entry ${refused.id} was asked by the ${refused.asker}; only the asker marks it done.`;
		case "AlreadyResolved":
			return `Entry ${refused.id} is already resolved.`;
		case "Undelivered":
			return `Entry ${refused.id}: the user's text on it hasn't reached the session yet, so it can't be resolved yet.`;
		case "OpenBelow":
			return `Entry ${refused.id} still has ${refused.below.length} open below it, so it can't be resolved yet: ${refused.below.join(", ")}.`;
		case "EmptyText":
			return `Entry ${refused.id}: the text is empty.`;
		case "MissingAttachment":
			return `Entry ${refused.id}: attachment ${refused.attachment} is missing from the draft; attach the file again.`;
		case "NothingUndelivered":
			return `Entry ${refused.id} has nothing waiting to be delivered; it may have just gone out.`;
		case "OtherDesk":
			return `Entry ${refused.id} is on another session's desk; a thread stays on one desk. Ask without a parent, or claim that desk first (desk_claim).`;
		case "NoSuchDesk":
			return `Session ${refused.session} has nothing on the desk to claim.`;
		case "DeskInUse":
			return `Session ${refused.session} is in desk mode, so its desk is still its own; it can be claimed once desk mode is off there or the session is gone.`;
	}
};

export const deliveryFailed = (failed: DeliveryFailed): string => `Delivering to ${failed.session}: ${failed.cause}`;
