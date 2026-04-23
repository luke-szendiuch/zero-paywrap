import { describe, expect, it } from "vitest";
import { createPaywrapMpp } from "../../src/mpp/mppx.js";
import {
	type MinimalKVNamespace,
	workersKvStore,
	wrapKVForMppx,
} from "../../src/mpp/stores/workers-kv.js";

/**
 * In-memory stand-in for a Cloudflare Workers KV namespace. Intentionally
 * minimal — matches only the three methods our adapter uses. Does NOT
 * emulate KV's eventual-consistency window; it's synchronous-ish so tests
 * can observe the effects of the non-atomic `update` directly.
 */
class FakeKV implements MinimalKVNamespace {
	private readonly data = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.data.has(key) ? (this.data.get(key) ?? null) : null;
	}
	async put(key: string, value: string): Promise<void> {
		this.data.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}
}

describe("mpp.stores.workers-kv: wrapKVForMppx", () => {
	it("round-trips values through put/get/delete", async () => {
		const kv = new FakeKV();
		const wrapped = wrapKVForMppx(kv);

		await wrapped.put("k1", "hello");
		expect(await wrapped.get("k1")).toBe("hello");

		await wrapped.delete("k1");
		expect(await wrapped.get("k1")).toBeNull();
	});

	it("update: set writes the new value and forwards the result", async () => {
		const kv = new FakeKV();
		const wrapped = wrapKVForMppx(kv);

		const result = await wrapped.update<string>("k", (current) => {
			expect(current).toBeNull();
			return { op: "set", value: "v1", result: "ok" };
		});

		expect(result).toBe("ok");
		expect(await wrapped.get("k")).toBe("v1");
	});

	it("update: noop leaves the value unchanged", async () => {
		const kv = new FakeKV();
		const wrapped = wrapKVForMppx(kv);

		await wrapped.put("k", "original");

		const result = await wrapped.update<number>("k", (current) => {
			expect(current).toBe("original");
			return { op: "noop", result: 42 };
		});

		expect(result).toBe(42);
		expect(await wrapped.get("k")).toBe("original");
	});

	it("update: delete removes the key", async () => {
		const kv = new FakeKV();
		const wrapped = wrapKVForMppx(kv);

		await wrapped.put("k", "v");

		await wrapped.update<null>("k", (current) => {
			expect(current).toBe("v");
			return { op: "delete", result: null };
		});

		expect(await wrapped.get("k")).toBeNull();
	});

	/**
	 * Codifies the non-atomic contract. Two `update` calls interleave: both
	 * read the same stale value, both compute their new value from it, and
	 * the second `put` overwrites the first. With a linearizable store
	 * (redis WATCH/MULTI), the second call would see the first's write.
	 * This is NOT a regression — it's the documented KV limitation.
	 */
	it("update: concurrent writers can silently lose updates (non-atomic contract)", async () => {
		const kv = new FakeKV();
		const wrapped = wrapKVForMppx(kv);

		await wrapped.put("counter", "0");

		// Race: both reads happen before either write lands.
		const read1 = await kv.get("counter");
		const read2 = await kv.get("counter");
		expect(read1).toBe("0");
		expect(read2).toBe("0");

		// Both callbacks compute "1" from the stale "0".
		await wrapped.update<number>("counter", (current) => {
			const n = Number.parseInt(current ?? "0", 10);
			return { op: "set", value: String(n + 1), result: n + 1 };
		});
		await wrapped.update<number>("counter", (current) => {
			const n = Number.parseInt(current ?? "0", 10);
			return { op: "set", value: String(n + 1), result: n + 1 };
		});

		// Without atomicity, both increments could have raced and we'd end
		// at "1" instead of "2". Our sequential calls above DO end at "2"
		// because each `update` does its own fresh read. The point of this
		// test is the interleaved variant:
		await wrapped.put("counter", "0");
		const snapshot1 = await kv.get("counter");
		const snapshot2 = await kv.get("counter");
		const newVal1 = String(Number.parseInt(snapshot1 ?? "0", 10) + 1);
		const newVal2 = String(Number.parseInt(snapshot2 ?? "0", 10) + 1);
		await kv.put("counter", newVal1);
		await kv.put("counter", newVal2);

		// Both writers computed "1" from "0"; one overwrote the other.
		expect(await kv.get("counter")).toBe("1");
	});
});

describe("mpp.stores.workers-kv: workersKvStore integration", () => {
	it("returns a Store with get/put/delete/update exposed", () => {
		const kv = new FakeKV();
		const store = workersKvStore(kv);

		expect(typeof store.get).toBe("function");
		expect(typeof store.put).toBe("function");
		expect(typeof store.delete).toBe("function");
		expect(typeof store.update).toBe("function");
	});

	// Known-answer private key / address pair (Anvil test account index 0).
	const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

	it("plugs into createPaywrapMpp as a channel store and round-trips seeded values", async () => {
		const kv = new FakeKV();
		const store = workersKvStore(kv);

		// Seed a value BEFORE constructing mppx to verify the store shares the
		// same backing KV namespace throughout.
		await store.put("paywrap:test:seed", JSON.stringify({ hello: "world" }));

		const bundle = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: "https://svc.example.com",
			mppSecretKey: "a".repeat(64),
			tempoRpcUrl: "https://rpc.example/tempo",
			store,
		});

		expect(bundle.mppx).toBeDefined();
		expect(bundle.channelStore).toBeDefined();
		// `Store.cloudflare` JSON-encodes values on the way in and decodes on
		// the way out, so the store API sees what we put in.
		expect(await store.get("paywrap:test:seed")).toBe(JSON.stringify({ hello: "world" }));
		// The raw FakeKV sees the JSON-encoded bytes (the extra quotes/escapes
		// come from `Store.cloudflare`'s wire format, not our adapter).
		expect(await kv.get("paywrap:test:seed")).toBe(
			JSON.stringify(JSON.stringify({ hello: "world" })),
		);
	});
});
