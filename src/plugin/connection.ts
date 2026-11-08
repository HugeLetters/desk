/**
 * A plugin instance's connection to the desk service: connects to its socket, starting the service (detached, so it
 * outlives this OpenCode) when nobody answers, says `hello`, and holds the connection while the plugin is loaded. If
 * the service goes away it reconnects, starting a new one, and says `hello` again; requests wait for that.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Method, Methods, Response } from "../protocol";

export interface Options {
	readonly socket: string;
	/** Starts the service; called when nothing answers on the socket. */
	readonly start: () => void;
	readonly hello: () => Methods["hello"]["input"];
	/** How long to wait for a started service to answer. */
	readonly timeout?: number;
}

export interface Connection {
	readonly request: <M extends Method>(method: M, input: Methods[M]["input"]) => Promise<Methods[M]["output"]>;
	/** The page's URL, from the service's answer to `hello`. */
	readonly url: () => Promise<string>;
	readonly close: () => void;
}

type Socket = Bun.Socket<undefined>;

export function connect(options: Options): Connection {
	const timeout = options.timeout ?? 10_000;
	const waiting = new Map<number, { resolve: (output: unknown) => void; reject: (error: Error) => void }>();
	let next = 0;
	let closed = false;
	let buffer = "";
	let current: Promise<{ socket: Socket; url: string }> | undefined;

	const dial = () =>
		Bun.connect({
			unix: options.socket,
			socket: {
				data(_socket, chunk) {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop()!;
					for (const line of lines) {
						if (!line.trim()) continue;
						const response = JSON.parse(line) as Response;
						const pending = waiting.get(response.id);
						waiting.delete(response.id);
						if ("error" in response) pending?.reject(new Error(response.error));
						else pending?.resolve(response.output);
					}
				},
				close() {
					current = undefined;
					buffer = "";
					for (const [id, pending] of waiting) {
						waiting.delete(id);
						pending.reject(new Error("The desk service went away; try again."));
					}
					// Hold on: reconnect (starting a new service), so this OpenCode stays reachable for deliveries.
					if (!closed) setTimeout(() => void ensure().catch(() => {}), 500);
				},
			},
		});

	const send = (socket: Socket, method: Method, input: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++next;
			waiting.set(id, { resolve, reject });
			socket.write(`${JSON.stringify({ id, method, input })}\n`);
		});

	const open = async () => {
		let socket = await dial().catch(() => undefined);
		if (!socket) {
			options.start();
			const deadline = Date.now() + timeout;
			while (!socket && Date.now() < deadline) {
				await Bun.sleep(50);
				socket = await dial().catch(() => undefined);
			}
			if (!socket) throw new Error(`The desk service didn't start (socket ${options.socket}).`);
		}
		if (closed) {
			socket.end();
			throw new Error("The desk plugin was unloaded.");
		}
		const { url } = (await send(socket, "hello", options.hello())) as Methods["hello"]["output"];
		return { socket, url };
	};

	const ensure = () => {
		current ??= open().catch((error) => {
			current = undefined;
			throw error;
		});
		return current;
	};

	void ensure().catch(() => {});

	return {
		request: async (method, input) => (await send((await ensure()).socket, method, input)) as never,
		url: async () => (await ensure()).url,
		close: () => {
			closed = true;
			void current?.then(({ socket }) => socket.end(), () => {});
		},
	};
}

/** Starts `bun src/service/main.ts` detached, logging to `<store>/service.log`. */
export function startService(env: { DESK_HOME: string; DESK_PORT: string }) {
	mkdirSync(env.DESK_HOME, { recursive: true });
	const log = openSync(join(env.DESK_HOME, "service.log"), "a");
	const main = join(dirname(import.meta.dir), "service", "main.ts");
	// Inside OpenCode, `process.execPath` is OpenCode's own binary, which runs as Bun with BUN_BE_BUN.
	const bun = Bun.which("bun");
	const child = spawn(bun ?? process.execPath, [main], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, ...env, ...(bun ? {} : { BUN_BE_BUN: "1" }) },
	});
	child.unref();
}
