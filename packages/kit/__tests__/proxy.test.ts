import { describe, expect, it } from "vitest";
import { proxyUpstreamRequest } from "../src/proxy/index.js";

const stubFetch = (response: Response): typeof globalThis.fetch =>
	(async () => response) as unknown as typeof globalThis.fetch;

describe("proxyUpstreamRequest", () => {
	it("returns kind:json when upstream content-type is application/json", async () => {
		const upstream = new Response(JSON.stringify({ ok: true, n: 1 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const out = await proxyUpstreamRequest({
			url: "https://x.example/echo",
			body: { foo: "bar" },
			fetchImpl: stubFetch(upstream),
		});
		expect(out.kind).toBe("json");
		expect(out.status).toBe(200);
		if (out.kind !== "json") throw new Error("type narrowing");
		expect(out.body).toEqual({ ok: true, n: 1 });
	});

	it("returns kind:binary when upstream content-type is image/png", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const upstream = new Response(bytes, {
			status: 200,
			headers: { "content-type": "image/png" },
		});
		const out = await proxyUpstreamRequest({
			url: "https://x.example/img",
			body: { prompt: "x" },
			fetchImpl: stubFetch(upstream),
		});
		expect(out.kind).toBe("binary");
		if (out.kind !== "binary") throw new Error("type narrowing");
		expect(out.contentType).toBe("image/png");
		expect(new Uint8Array(out.body)).toEqual(bytes);
	});

	it("returns kind:binary for application/pdf", async () => {
		const upstream = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		});
		const out = await proxyUpstreamRequest({
			url: "https://x.example/pdf",
			body: { html: "<h1>hi</h1>" },
			fetchImpl: stubFetch(upstream),
		});
		expect(out.kind).toBe("binary");
	});

	it("preserves upstream status codes including 4xx/5xx", async () => {
		const upstream = new Response(JSON.stringify({ error: "rate_limited" }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});
		const out = await proxyUpstreamRequest({
			url: "https://x.example",
			body: {},
			fetchImpl: stubFetch(upstream),
		});
		expect(out.status).toBe(429);
		if (out.kind !== "json") throw new Error("type narrowing");
		expect(out.body).toEqual({ error: "rate_limited" });
	});

	it("handles claimed-JSON-but-unparseable body without throwing", async () => {
		const upstream = new Response("not actually json", {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const out = await proxyUpstreamRequest({
			url: "https://x.example",
			body: {},
			fetchImpl: stubFetch(upstream),
		});
		expect(out.kind).toBe("json");
		if (out.kind !== "json") throw new Error("type narrowing");
		expect(out.body).toEqual({ error: "non_json_response", raw: "not actually json" });
	});

	it("auto-sets request content-type to JSON when body is provided and caller didn't", async () => {
		let capturedHeaders: HeadersInit | undefined;
		const stub = (async (_url: string, init: RequestInit) => {
			capturedHeaders = init.headers;
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		await proxyUpstreamRequest({
			url: "https://x.example",
			body: { x: 1 },
			fetchImpl: stub,
		});
		const headers = capturedHeaders as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
	});
});
