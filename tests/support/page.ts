import { expect } from "bun:test";

/** The page at `url` is Vite's build: the shell, its script (the app, which calls /rpc) and styles, and Mermaid's chunk. */
export async function expectBuiltPage(url: string) {
	const shell = await (await fetch(url)).text();
	const script = /<script type="module" crossorigin src="([^"]+)">/.exec(shell)?.[1];
	const style = /<link rel="stylesheet" crossorigin href="([^"]+)">/.exec(shell)?.[1];
	expect(script).toBeDefined();
	expect(style).toBeDefined();
	const app = await fetch(`${url}${script}`);
	expect(app.headers.get("content-type")).toContain("javascript");
	const code = await app.text();
	expect(code).toContain("/rpc");
	const mermaid = /["'](assets\/mermaid\.core-[\w-]+\.js)["']/.exec(code)?.[1];
	expect(mermaid).toBeDefined();
	expect((await fetch(`${url}/${mermaid}`)).status).toBe(200);
	expect((await fetch(`${url}${style}`)).headers.get("content-type")).toContain("css");
}
