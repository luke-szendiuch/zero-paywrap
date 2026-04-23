import { describe, expect, it } from "vitest";
import { assertVoucherAdvances } from "../../src/mpp/verify.js";

// NOTE: `verifyWithScope` is a 5-line passthrough to `mppx.verifyCredential`
// with the scope parameter promoted from optional options to a required
// argument. Exercising it end-to-end requires minting a real mppx credential
// (chain + wallet + HMAC) just to prove the wrapper forwards the call — not
// worth the complexity. The one-sentence behavior (throws when scope is
// absent from the underlying credential) is covered transitively in the
// redis consumer's integration suite.

describe("mpp.verify.assertVoucherAdvances", () => {
	it("passes when the voucher advances by exactly minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 150n, 50n)).not.toThrow();
	});

	it("passes when the voucher advances by more than minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 200n, 50n)).not.toThrow();
	});

	it("throws voucher_non_advancing when delta is less than minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 120n, 50n)).toThrow("voucher_non_advancing");
	});

	it("throws voucher_non_advancing when the voucher matches current (replay)", () => {
		expect(() => assertVoucherAdvances(100n, 100n, 1n)).toThrow("voucher_non_advancing");
	});

	it("throws voucher_non_advancing when the voucher REGRESSES below current", () => {
		expect(() => assertVoucherAdvances(100n, 50n, 1n)).toThrow("voucher_non_advancing");
	});

	it("passes when both sides are zero and minDelta is zero (degenerate but valid)", () => {
		expect(() => assertVoucherAdvances(0n, 0n, 0n)).not.toThrow();
	});
});
