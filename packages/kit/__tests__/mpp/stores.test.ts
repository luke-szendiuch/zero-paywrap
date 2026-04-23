import { describe, expect, it } from "vitest";
import { memoryStore, wrapIoredisForMppx } from "../../src/mpp/stores.js";

describe("mpp.stores.memoryStore", () => {
	it("round-trips values through put/get/delete", async () => {
		const store = memoryStore();
		await store.put("k1", "hello");
		expect(await store.get("k1")).toBe("hello");
		await store.delete("k1");
		expect(await store.get("k1")).toBeNull();
	});

	it("supports atomic update: set", async () => {
		const store = memoryStore();
		const result = await store.update<"k", string>("k", () => ({
			op: "set",
			value: "v",
			result: "ok",
		}));
		expect(result).toBe("ok");
		expect(await store.get("k")).toBe("v");
	});

	it("supports atomic update: noop leaves value unchanged", async () => {
		const store = memoryStore();
		await store.put("k", "original");
		const result = await store.update<"k", number>("k", (current) => {
			expect(current).toBe("original");
			return { op: "noop", result: 42 };
		});
		expect(result).toBe(42);
		expect(await store.get("k")).toBe("original");
	});

	it("supports atomic update: delete", async () => {
		const store = memoryStore();
		await store.put("k", "v");
		await store.update<"k", null>("k", () => ({
			op: "delete",
			result: null,
		}));
		expect(await store.get("k")).toBeNull();
	});
});

describe("mpp.stores.wrapIoredisForMppx (shape only)", () => {
	// Note: the actual Redis adapter requires a real (or mocked) Redis client
	// with WATCH/MULTI/EXEC semantics, which we don't stand up in unit tests.
	// We verify the wrapper exposes the mppx adapter surface so a shape
	// regression is caught here.
	it("returns an object with get/set/del/update", () => {
		const stub = {} as unknown as Parameters<typeof wrapIoredisForMppx>[0];
		const wrapped = wrapIoredisForMppx(stub);
		expect(typeof wrapped.get).toBe("function");
		expect(typeof wrapped.set).toBe("function");
		expect(typeof wrapped.del).toBe("function");
		expect(typeof wrapped.update).toBe("function");
	});
});
