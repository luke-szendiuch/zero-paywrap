import { describe, expect, it } from "vitest";
import { encodeSessionReceipt } from "../src/auth/index.js";

/**
 * The Zero CLI's `decodeSessionReceiptHeader` is the canonical decoder
 * (cli `payment-service.ts`). It pads the input with `=` if `length % 4`
 * is non-zero, so we MUST emit base64url WITHOUT padding (or with) — the
 * decoder is tolerant. We strip padding for cleanliness.
 *
 * This test re-implements the CLI's decode shape so we keep the wire
 * format pinned even if the CLI repo changes.
 */
const decodeAsCli = (header: string) => {
	const padLen = (4 - (header.length % 4)) % 4;
	const padded = header.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
	const json = Buffer.from(padded, "base64").toString("utf8");
	return JSON.parse(json) as Record<string, unknown>;
};

describe("encodeSessionReceipt", () => {
	it("round-trips through the CLI's decode shape", () => {
		const payload = {
			channelId: "0xabc123",
			challengeId: "ch_test_42",
			acceptedCumulative: "12345",
			spent: "12345",
		};
		const encoded = encodeSessionReceipt(payload);
		const decoded = decodeAsCli(encoded);
		expect(decoded).toEqual(payload);
	});

	it("is URL-safe (no `+` `/` `=` characters)", () => {
		// Build a payload whose JSON includes bytes that classic base64 would
		// emit as `+` or `/`. Any non-ASCII unicode triggers it reliably.
		const payload = {
			channelId: "0xff".padEnd(66, "f"),
			challengeId: "ch_with_high_bytes_😀_τέλος",
			acceptedCumulative: (10n ** 18n).toString(),
			spent: (10n ** 18n).toString(),
		};
		const encoded = encodeSessionReceipt(payload);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(decodeAsCli(encoded)).toEqual(payload);
	});

	it("includes optional txHash when provided", () => {
		const payload = {
			channelId: "0xc",
			challengeId: "id",
			acceptedCumulative: "0",
			spent: "0",
			txHash: "0xdeadbeef",
		};
		const encoded = encodeSessionReceipt(payload);
		expect(decodeAsCli(encoded)).toEqual(payload);
	});

	it("omits txHash from output when undefined (no JSON null leak)", () => {
		const payload = {
			channelId: "0xc",
			challengeId: "id",
			acceptedCumulative: "100",
			spent: "100",
		};
		const encoded = encodeSessionReceipt(payload);
		const decoded = decodeAsCli(encoded);
		expect("txHash" in decoded).toBe(false);
	});
});
