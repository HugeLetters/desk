import { expect } from "bun:test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";

const runs = Number(process.env.PROPERTY_RUNS ?? 200);

/** Runs a property; a counterexample fails the test with the shrunk input and how to replay it. */
export const check = async <A>(
	arbitrary: Arbitrary.Arbitrary<A>,
	property: (value: A) => boolean | Effect.Effect<boolean, unknown>,
) => {
	const result = await Effect.runPromise(Arbitrary.checkEffect(arbitrary, property, { runs }));
	expect(Arbitrary.formatCheckFailure(result) ?? "passed").toBe("passed");
};
