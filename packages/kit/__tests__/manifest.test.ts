import { describe, expect, it } from "vitest";
import { type PaywrapManifest, buildPaywrapJson } from "../src/manifest/index.js";

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
