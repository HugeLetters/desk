/** The desk service as the tools and `/desk-mode` call it: through the connection, and never for longer than `timeout`. */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Connection from "./connection";

export interface Calls {
	/**
	 * Runs `f` against the service, once this instance is connected. A desk call takes milliseconds; one still running
	 * after `timeout` (waiting for the connection included) means the service is stuck, and the agent (or the user, for
	 * /desk-mode) hears so instead of waiting for good.
	 */
	readonly service: <A, E>(
		f: (client: Connection.Client) => Effect.Effect<A, E>,
	) => Effect.Effect<A, E | Connection.DeskError>;
}

/** `registration`: the service's `service.json`, whose pid the user can kill. */
export const make = (connection: Connection.Connection, timeout: Duration.Duration, registration: string): Calls => ({
	service: (f) =>
		Effect.flatMap(connection.client, f).pipe(
			Effect.timeoutOrElse({
				duration: timeout,
				orElse: () =>
					new Connection.DeskError({
						message: `The desk service didn't answer within ${Duration.format(timeout)}; it may be stuck. The user can restart it: kill the pid in ${registration}.`,
					}),
			}),
		),
});
