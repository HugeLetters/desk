/** The page's routes (`src/api/routes.ts`), which the page matches and the service, the TUI and the demo link to. */
import { expect, test } from "bun:test";
import { deskPath, entryPath, link, rpcUrl, serviceUrl, sessionIn } from "../src/api/routes";

test("a desk is /sessions/<id>, an entry /sessions/<id>/questions/<entry id>, and the path gives its desk back", () => {
	expect(deskPath("ses_a")).toBe("/sessions/ses_a");
	expect(entryPath("ses_a", "0190abcd")).toBe("/sessions/ses_a/questions/0190abcd");
	const page = new URL("http://127.0.0.1:47400/");
	expect(link(page, deskPath("ses_a")).href).toBe("http://127.0.0.1:47400/sessions/ses_a");
	expect(link(page, "/").href).toBe("http://127.0.0.1:47400/");
	expect(serviceUrl(47400).href).toBe("http://127.0.0.1:47400/");
	expect(rpcUrl(47400).href).toBe("ws://127.0.0.1:47400/rpc");
	expect(sessionIn(entryPath("ses a/b", "x"))).toBe("ses a/b");
	expect(sessionIn("/")).toBeUndefined();
});
