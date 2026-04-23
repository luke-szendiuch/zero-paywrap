import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check.js";

/**
 * Spin up a tiny in-memory HTTP server that returns canned responses on
 * `/healthz` and `/.well-known/paywrap.json`. `runCheck` hits both and
 * pretty-prints — we capture stdout writes and assert on them.
 */
const startServer = (
	handler: (
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	) => void,
): Promise<{ server: Server; url: string }> =>
	new Promise((resolvePromise) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("bad server address");
			resolvePromise({ server, url: `http://127.0.0.1:${addr.port}` });
		});
	});

const stopServer = (server: Server): Promise<void> =>
	new Promise((resolvePromise, reject) =>
		server.close((err) => (err ? reject(err) : resolvePromise())),
	);

describe("paywrap check <url>", () => {
	let server: Server | null = null;
	let baseUrl = "";
	let output = "";
	const originalWrite = process.stdout.write.bind(process.stdout);

	beforeEach(() => {
		output = "";
		// biome-ignore lint/suspicious/noExplicitAny: capture stdout
		(process.stdout.write as any) = (chunk: string | Uint8Array) => {
			output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		};
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		if (server) {
			await stopServer(server);
			server = null;
		}
	});

	it("prints healthz + paywrap.json bodies when both respond", async () => {
		const started = await startServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/healthz") {
				res.statusCode = 200;
				res.end(JSON.stringify({ ok: true, probes: { db: "up" } }));
			} else if (req.url === "/.well-known/paywrap.json") {
				res.statusCode = 200;
				res.end(
					JSON.stringify({
						wallet: "0xabc",
						paidRoutes: [],
						freeRoutes: [],
					}),
				);
			} else {
				res.statusCode = 404;
				res.end("not found");
			}
		});
		server = started.server;
		baseUrl = started.url;

		await runCheck(baseUrl);
		expect(output.includes("HEALTHZ")).toBe(true);
		expect(output.includes("PAYWRAP.JSON")).toBe(true);
		expect(output.includes(`"ok": true`)).toBe(true);
		expect(output.includes(`"wallet": "0xabc"`)).toBe(true);
		expect(output.includes("status: 200")).toBe(true);
	});

	it("surfaces 503 + down probes without aborting", async () => {
		const started = await startServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/healthz") {
				res.statusCode = 503;
				res.end(JSON.stringify({ ok: false, probes: { db: "down" } }));
			} else {
				res.statusCode = 200;
				res.end(JSON.stringify({ wallet: "0xdef", paidRoutes: [], freeRoutes: [] }));
			}
		});
		server = started.server;
		baseUrl = started.url;
		await runCheck(baseUrl);
		expect(output.includes("status: 503")).toBe(true);
		expect(output.includes(`"ok": false`)).toBe(true);
	});

	it("trims a trailing slash on the base url", async () => {
		const started = await startServer((_req, res) => {
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end("{}");
		});
		server = started.server;
		baseUrl = started.url;
		await runCheck(`${baseUrl}/`);
		// No double-slash in the probed URLs
		expect(output.includes(`${baseUrl}//`)).toBe(false);
	});
});
