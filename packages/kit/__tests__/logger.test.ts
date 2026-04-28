import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LoggerCallback,
	type PaywrapLogEvent,
	consoleJsonLogger,
	safeLog,
	shortFingerprint,
} from "../src/logger/index.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("consoleJsonLogger", () => {
	it("emits a JSON line per event on console.log for non-failures", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const event: PaywrapLogEvent = {
			v: 1,
			kind: "payment_required",
			timestamp: "2026-04-27T20:00:00Z",
			protocol: "mpp",
			route: "POST /v1/sandboxes",
			scope: "test:1",
			intent: "charge",
			amountUsdcMicro: "50000",
		};
		consoleJsonLogger(event);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual(event);
	});

	it("routes payment_failed to console.error", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleJsonLogger({
			v: 1,
			kind: "payment_failed",
			timestamp: "2026-04-27T20:00:00Z",
			protocol: "x402",
			stage: "settle",
			reason: "facilitator_5xx",
		});
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("schema versions every event with v: 1", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const events: PaywrapLogEvent[] = [
			{
				v: 1,
				kind: "payment_required",
				timestamp: "t",
				protocol: "mpp",
				route: "r",
				scope: "s",
			},
			{
				v: 1,
				kind: "payment_settled",
				timestamp: "t",
				protocol: "x402",
				payer: "0x1",
				seller: "0x2",
				amountUsdcMicro: "0",
				route: "r",
				latencyMs: 0,
			},
			{
				v: 1,
				kind: "request_completed",
				timestamp: "t",
				route: "r",
				status: 200,
				latencyMs: 5,
			},
		];
		for (const e of events) consoleJsonLogger(e);
		for (const call of spy.mock.calls) {
			expect(JSON.parse(call[0] as string).v).toBe(1);
		}
	});
});

describe("safeLog", () => {
	it("is a no-op when logger is undefined", async () => {
		await expect(
			safeLog(undefined, {
				v: 1,
				kind: "payment_required",
				timestamp: "t",
				protocol: "mpp",
				route: "r",
				scope: "s",
			}),
		).resolves.toBeUndefined();
	});

	it("invokes a configured logger with the event", async () => {
		const fn = vi.fn();
		await safeLog(fn as LoggerCallback, {
			v: 1,
			kind: "request_completed",
			timestamp: "t",
			route: "r",
			status: 200,
			latencyMs: 5,
		});
		expect(fn).toHaveBeenCalledWith(expect.objectContaining({ kind: "request_completed", v: 1 }));
	});

	it("swallows synchronous logger errors", async () => {
		const throwing: LoggerCallback = () => {
			throw new Error("boom");
		};
		await expect(
			safeLog(throwing, {
				v: 1,
				kind: "payment_failed",
				timestamp: "t",
				protocol: "mpp",
				stage: "verify",
				reason: "x",
			}),
		).resolves.toBeUndefined();
	});

	it("swallows async logger rejections", async () => {
		const rejecting: LoggerCallback = async () => {
			throw new Error("downstream 500");
		};
		await expect(
			safeLog(rejecting, {
				v: 1,
				kind: "payment_failed",
				timestamp: "t",
				protocol: "x402",
				stage: "settle",
				reason: "x",
			}),
		).resolves.toBeUndefined();
	});
});

describe("shortFingerprint", () => {
	it("returns the first 16 chars of a 64-char digest", () => {
		const digest = "a".repeat(64);
		expect(shortFingerprint(digest)).toBe("a".repeat(16));
	});

	it("returns shorter strings unchanged when below 16 chars", () => {
		expect(shortFingerprint("abc")).toBe("abc");
	});
});
