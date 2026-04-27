import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createPaywrapX402 } from "@zeroclickai/paywrap/x402";
import { Hono } from "hono";

const onError = (app: Hono) => {
	app.onError((err) => {
		throw err;
	});
	return app;
};
import { describe, expect, it } from "vitest";
import { x402Gated } from "../src/index.js";

const PAY_TO = "0x9CC42f3d9245B867ACccd630B43f906c1665b176" as const;

/**
 * Minimal facilitator stub. `getSupported` advertises exact-evm on both Base
 * networks; without this the resource server bails out of payment-requirements
 * construction with "Facilitator does not support …".
 */
const makeStubFacilitator = () => ({
	verify: async () => ({}) as never,
	settle: async () => ({}) as never,
	getSupported: async () =>
		({
			kinds: [
				{ x402Version: 2, scheme: "exact", network: "eip155:8453" },
				{ x402Version: 2, scheme: "exact", network: "eip155:84532" },
			],
		}) as never,
});

describe("x402Gated", () => {
	it("returns 402 with x402-spec body on unpaid requests", async () => {
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base",
			facilitator: makeStubFacilitator(),
		});
		const app = onError(new Hono());
		app.post(
			"/generate",
			x402Gated(x402, {
				price: "0.005",
				description: "test route",
				syncFacilitatorOnStart: true,
			}),
			(c) => c.json({ ok: true }),
		);

		const res = await app.request("/generate", { method: "POST" });
		expect(res.status).toBe(402);
		const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
		expect(required.x402Version).toBeDefined();
		expect(required.accepts[0]?.payTo).toBe(PAY_TO);
	});

	it("supports per-route payTo override", async () => {
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base",
			facilitator: makeStubFacilitator(),
		});
		const override = "0x253671ba1267Bc9F21F3E51A0e6D07928753470B" as const;
		const app = onError(new Hono());
		app.post(
			"/x",
			x402Gated(x402, {
				price: "0.01",
				payTo: override,
				syncFacilitatorOnStart: true,
			}),
			(c) => c.json({}),
		);
		const res = await app.request("/x", { method: "POST" });
		const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
		expect(required.accepts[0]?.payTo).toBe(override);
	});

	it("targets the configured network's CAIP-2 id", async () => {
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base-sepolia",
			facilitator: makeStubFacilitator(),
		});
		const app = onError(new Hono());
		app.get(
			"/free-with-paywall",
			x402Gated(x402, { price: "0.001", syncFacilitatorOnStart: true }),
			(c) => c.json({}),
		);
		const res = await app.request("/free-with-paywall", { method: "GET" });
		const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
		expect(required.accepts[0]?.network).toBe("eip155:84532");
	});
});
