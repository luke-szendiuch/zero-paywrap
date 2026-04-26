/**
 * Upstream proxy helpers.
 *
 * Most paywrap services with `intent: "charge"` are thin proxies in front
 * of an upstream API: settle the charge, validate the body, forward to the
 * upstream, return whatever the upstream returned. The trap every consumer
 * hits at least once: upstreams return mixed content types — JSON for
 * structured endpoints, binary for image/PDF/audio — and the naive
 * "always parse JSON" client corrupts the binary endpoints, charging
 * the buyer for nothing.
 *
 * `proxyUpstreamRequest` returns a discriminated `{kind: "json" | "binary"}`
 * so consumer routes can pass binary through verbatim with the upstream's
 * Content-Type intact, while still getting parsed objects on JSON endpoints.
 *
 * Worker-safe: pure fetch + Web standards. No Node imports.
 */

export type UpstreamProxyResponse =
	| { kind: "json"; status: number; contentType: string; body: unknown }
	| { kind: "binary"; status: number; contentType: string; body: ArrayBuffer };

export type ProxyUpstreamRequestArgs = {
	url: string;
	method?: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
	headers?: Record<string, string>;
	/** JSON-stringified before sending. Pass `undefined` to omit. */
	body?: unknown;
	/**
	 * Override the fetch impl. Default `globalThis.fetch`. Useful for tests
	 * that want to inject a mock without mutating globals.
	 */
	fetchImpl?: typeof globalThis.fetch;
};

const isJsonContentType = (contentType: string): boolean => {
	const head = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (head === "" || head === "application/json") return true;
	if (head.endsWith("+json")) return true;
	return false;
};

/**
 * One round-trip to an upstream API with content-type-aware response shaping.
 *
 * Behavior:
 *   - JSON-content-type response → parses to `body: unknown` (or `{error: "non_json_response", raw: <truncated>}` if the body claims JSON but doesn't parse)
 *   - Anything else → returns `body: ArrayBuffer` so the caller can pass the bytes through unmodified
 *
 * Status codes pass through verbatim. The caller is responsible for
 * mapping upstream 429/5xx into client-facing semantics (e.g. 429 → 503
 * retryable, 5xx → 502 with refund-trail logging).
 */
export const proxyUpstreamRequest = async (
	args: ProxyUpstreamRequestArgs,
): Promise<UpstreamProxyResponse> => {
	const fetchImpl = args.fetchImpl ?? globalThis.fetch;
	const headers = { ...(args.headers ?? {}) };
	const init: RequestInit = {
		method: args.method ?? "POST",
		headers,
	};
	if (args.body !== undefined) {
		init.body = JSON.stringify(args.body);
		if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
			headers["content-type"] = "application/json";
		}
	}
	const r = await fetchImpl(args.url, init);
	const contentType = r.headers.get("content-type") ?? "";
	if (isJsonContentType(contentType)) {
		const text = await r.text();
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = { error: "non_json_response", raw: text.slice(0, 1024) };
		}
		return { kind: "json", status: r.status, contentType, body };
	}
	const buf = await r.arrayBuffer();
	return { kind: "binary", status: r.status, contentType, body: buf };
};
