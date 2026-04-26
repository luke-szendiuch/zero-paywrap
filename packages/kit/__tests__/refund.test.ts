import { afterEach, describe, expect, it, vi } from "vitest";
import { recordRefundOwed } from "../src/refund/index.js";

describe("recordRefundOwed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits a single console.error JSON line with the canonical shape", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		recordRefundOwed({
			payer: "0xabc",
			sku: "jigsaw-image-gen:v2",
			amountUsdcMicro: 50_000n,
			reason: "upstream_5xx",
			details: { upstreamStatus: 503 },
			chargeHash: "ff00",
			timestamp: "2026-04-26T00:00:00.000Z",
		});
		expect(spy).toHaveBeenCalledOnce();
		const arg = spy.mock.calls[0]?.[0] as string;
		expect(typeof arg).toBe("string");
		expect(JSON.parse(arg)).toEqual({
			msg: "paywrap_refund_owed",
			payer: "0xabc",
			sku: "jigsaw-image-gen:v2",
			amountUsdcMicro: "50000",
			reason: "upstream_5xx",
			chargeHash: "ff00",
			details: { upstreamStatus: 503 },
			timestamp: "2026-04-26T00:00:00.000Z",
		});
	});

	it("defaults timestamp to the current ISO time", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		recordRefundOwed({
			payer: "0xabc",
			sku: "x:v1",
			amountUsdcMicro: 1_000n,
			reason: "test",
		});
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
		expect(typeof parsed.timestamp).toBe("string");
		expect(() => new Date(parsed.timestamp)).not.toThrow();
	});

	it("omits chargeHash + details when not provided", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		recordRefundOwed({
			payer: "0xabc",
			sku: "x:v1",
			amountUsdcMicro: 1_000n,
			reason: "test",
		});
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
		expect(parsed.chargeHash).toBeUndefined();
		expect(parsed.details).toBeUndefined();
	});
});
