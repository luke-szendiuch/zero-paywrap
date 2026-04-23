import { Store } from "mppx/server";

type Change<value, result> = Store.Change<value, result>;

/**
 * Minimal Cloudflare Workers KV surface we depend on. Intentionally NOT
 * `@cloudflare/workers-types` — we only need three methods, and don't want
 * consumers pulling Workers types transitively through paywrap. The real
 * `KVNamespace` is structurally assignable.
 */
export interface MinimalKVNamespace {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * ⚠️ Workers KV is NOT linearizable. This adapter satisfies mppx's
 * `AtomicStore` interface mechanically, but concurrent writers to the same
 * key can silently lose updates (last-write-wins over KV's
 * eventual-consistency window, up to ~60s globally).
 *
 * Safe for: charge-intent services (replay protection only), low-concurrency
 * sessions. UNSAFE for: real-concurrency session services (two vouchers for
 * the same channel arriving within the consistency window can corrupt
 * `cumulativeAmount`).
 *
 * For linearizable storage on Workers, use a Durable Object-backed store
 * (future work). This file is the cheap path for v1.
 */
export const workersKvStore = (kv: MinimalKVNamespace) => Store.cloudflare(wrapKVForMppx(kv));

export const wrapKVForMppx = (kv: MinimalKVNamespace) => ({
	async get(key: string) {
		return kv.get(key);
	},
	async put(key: string, value: string) {
		await kv.put(key, value);
	},
	async delete(key: string) {
		await kv.delete(key);
	},
	// Non-atomic read-compute-write — KV has no CAS. See file docblock.
	async update<result>(
		key: string,
		fn: (current: string | null) => Change<string, result>,
	): Promise<result> {
		const current = await kv.get(key);
		const change = fn(current);
		if (change.op === "noop") return change.result;
		if (change.op === "set") await kv.put(key, change.value);
		else if (change.op === "delete") await kv.delete(key);
		return change.result;
	},
});
