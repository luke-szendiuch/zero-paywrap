import { describe, expect, it } from "vitest";
import { aggregateHealthProbes } from "../src/health/index.js";

describe("health", () => {
	it("returns 200 when every probe resolves 'up'", async () => {
		const result = await aggregateHealthProbes({
			probes: {
				db: async () => "up",
				redis: () => "up",
			},
		});

		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.body.probes).toEqual({ db: "up", redis: "up" });
	});

	it("returns 503 when any probe resolves something other than 'up'", async () => {
		const result = await aggregateHealthProbes({
			probes: {
				db: async () => "up",
				redis: async () => "down",
			},
		});

		expect(result.status).toBe(503);
		expect(result.body.ok).toBe(false);
		expect(result.body.probes.redis).toBe("down");
		expect(result.body.probes.db).toBe("up");
	});

	it("treats a throwing probe as 'down'", async () => {
		const result = await aggregateHealthProbes({
			probes: {
				db: async () => "up",
				redis: async () => {
					throw new Error("connection refused");
				},
			},
		});

		expect(result.status).toBe(503);
		expect(result.body.probes.redis).toBe("down");
	});

	it("merges extras into the body without clobbering core fields", async () => {
		const result = await aggregateHealthProbes({
			probes: { db: () => "up" },
			extras: { wallet: "0xabc", version: "1.2.3", stripeReady: true },
		});

		expect(result.status).toBe(200);
		expect(result.body.wallet).toBe("0xabc");
		expect(result.body.version).toBe("1.2.3");
		expect(result.body.stripeReady).toBe(true);
		// core fields should still be present
		expect(result.body.ok).toBe(true);
		expect(result.body.probes.db).toBe("up");
	});

	it("handles an empty probe map as healthy", async () => {
		const result = await aggregateHealthProbes({ probes: {} });
		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.body.probes).toEqual({});
	});
});
