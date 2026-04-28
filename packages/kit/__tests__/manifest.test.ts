import { describe, expect, it } from "vitest";
import { type PaywrapManifest, buildOpenApiSpec, buildPaywrapJson } from "../src/manifest/index.js";

describe("manifest", () => {
	it("returns a manifest with the expected shape", () => {
		const manifest: PaywrapManifest = {
			wallet: "0xabc0000000000000000000000000000000000001",
			paidRoutes: [
				{
					method: "POST",
					path: "/v1/provision",
					protocol: "mpp",
					sku: "essentials-250mb-30d",
					priceUsdcMicro: "250000",
					pricingVersion: 1,
					description: "Provision a Redis instance",
				},
			],
			freeRoutes: [{ method: "GET", path: "/healthz" }],
		};

		const json = buildPaywrapJson(manifest);

		expect(json).toEqual(manifest);
		expect(json.paidRoutes).toHaveLength(1);
		expect(json.paidRoutes[0]?.protocol).toBe("mpp");
		expect(json.paidRoutes[0]?.sku).toBe("essentials-250mb-30d");
		expect(json.freeRoutes[0]?.path).toBe("/healthz");
	});

	it("supports per-route wallet overrides", () => {
		const perRouteWallet = "0xdef0000000000000000000000000000000000002";
		const manifest: PaywrapManifest = {
			wallet: "0xabc0000000000000000000000000000000000001",
			paidRoutes: [
				{
					method: "POST",
					path: "/v1/alt",
					protocol: "mpp",
					sku: "alt-sku",
					priceUsdcMicro: "500000",
					pricingVersion: 2,
					description: "Alt route settling to a different wallet",
					wallet: perRouteWallet,
				},
			],
			freeRoutes: [],
		};

		const json = buildPaywrapJson(manifest);

		expect(json.paidRoutes[0]?.wallet).toBe(perRouteWallet);
		expect(json.wallet).not.toBe(perRouteWallet);
	});

	it("preserves empty arrays (no paid/free routes)", () => {
		const json = buildPaywrapJson({
			wallet: "0x0000000000000000000000000000000000000001",
			paidRoutes: [],
			freeRoutes: [],
		});

		expect(json.paidRoutes).toEqual([]);
		expect(json.freeRoutes).toEqual([]);
	});
});

describe("buildOpenApiSpec", () => {
	const manifest: PaywrapManifest = {
		wallet: "0xabc0000000000000000000000000000000000001",
		paidRoutes: [
			{
				method: "POST",
				path: "/v1/sandboxes",
				protocol: "mpp",
				sku: "sandbox:30m",
				priceUsdcMicro: "50000",
				pricingVersion: 1,
				description: "Provision a sandbox",
			},
			{
				method: "POST",
				path: "/v1/x402/sandboxes",
				protocol: "x402",
				sku: "sandbox:30m",
				priceUsdcMicro: "50000",
				pricingVersion: 1,
				description: "Provision a sandbox via x402",
			},
		],
		freeRoutes: [
			{ method: "GET", path: "/healthz", description: "Health check" },
			{ method: "GET", path: "/v1/sandboxes/:id" },
		],
	};

	it("emits a valid OpenAPI 3.0.3 doc with one path per route", () => {
		const spec = buildOpenApiSpec(manifest, { title: "Daytona", version: "1.0" });
		expect(spec.openapi).toBe("3.0.3");
		expect(spec.info).toEqual({ title: "Daytona", version: "1.0" });
		expect(Object.keys(spec.paths).sort()).toEqual([
			"/healthz",
			"/v1/sandboxes",
			"/v1/sandboxes/:id",
			"/v1/x402/sandboxes",
		]);
	});

	it("annotates paid routes with x-paywrap metadata + 402 response", () => {
		const spec = buildOpenApiSpec(manifest, { title: "x", version: "1" });
		const paid = spec.paths["/v1/x402/sandboxes"]?.post as Record<string, unknown>;
		const xpw = paid?.["x-paywrap"] as Record<string, unknown>;
		expect(xpw.protocol).toBe("x402");
		expect(xpw.sku).toBe("sandbox:30m");
		expect(xpw.priceUsdcMicro).toBe("50000");
		const responses = paid?.responses as Record<string, unknown>;
		expect(responses["402"]).toEqual({ $ref: "#/components/schemas/PaymentRequired" });
	});

	it("does not annotate free routes with x-paywrap or 402", () => {
		const spec = buildOpenApiSpec(manifest, { title: "x", version: "1" });
		const free = spec.paths["/healthz"]?.get as Record<string, unknown>;
		expect(free["x-paywrap"]).toBeUndefined();
		const responses = free.responses as Record<string, unknown>;
		expect(responses["402"]).toBeUndefined();
	});

	it("throws on unsupported HTTP methods", () => {
		expect(() =>
			buildOpenApiSpec(
				{
					wallet: "0x1",
					paidRoutes: [],
					freeRoutes: [{ method: "TRACE", path: "/x" }],
				},
				{ title: "x", version: "1" },
			),
		).toThrow(/unsupported HTTP method/);
	});

	it("includes a server entry when serverUrl is provided", () => {
		const spec = buildOpenApiSpec(
			manifest,
			{ title: "x", version: "1" },
			{
				serverUrl: "https://example.com",
			},
		);
		expect(spec.servers).toEqual([{ url: "https://example.com" }]);
	});

	it("normalizes operationIds to safe identifiers", () => {
		const spec = buildOpenApiSpec(manifest, { title: "x", version: "1" });
		const get = spec.paths["/v1/sandboxes/:id"]?.get as Record<string, unknown>;
		expect(get.operationId).toBe("get__v1_sandboxes__id");
	});
});
