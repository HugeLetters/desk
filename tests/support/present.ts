/** The value, failing the test when it's missing (null or undefined). */
export function present<A>(value: A | null | undefined): A {
	if (value === null || value === undefined) throw new Error(`expected a value, got ${value}`);
	return value;
}
