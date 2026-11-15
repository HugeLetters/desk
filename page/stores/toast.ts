/** The toast: what the last action did, or why it failed. */
import * as Schema from "effect/Schema";
import { createSignal } from "solid-js";
import { Refusal } from "../../src/model/errors";
import { refusal } from "../../src/model/wording";

const isRefusal = Schema.is(Refusal);

export const createToast = () => {
	const [toast, setToast] = createSignal<{ message: string; error: boolean }>();

	function notify(message: string, error = false) {
		const shown = { message, error };
		setToast(shown);
		setTimeout(() => toast() === shown && setToast(undefined), error ? 6000 : 2500);
	}

	/** Runs `action` and shows what it says it did, or why it failed (the desk's refusals worded). */
	const attempt = (action: () => Promise<string>) =>
		action().then(notify, (error: unknown) =>
			notify(isRefusal(error) ? refusal(error) : String((error as { message?: unknown })?.message ?? error), true),
		);

	return { toast, notify, attempt };
};
