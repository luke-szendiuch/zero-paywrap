import { Store } from "mppx/server";

type Change<value, result> = Store.Change<value, result>;

/**
 * Minimal Cloudflare Workers KV surface we depend on. Intentionally NOT
 * `@cloudflare/workers-types` — we only need three methods, and we don't
 * want consumers pulling Workers types transitively through paywrap.
 *
 * The real `KVNamespace` is structurally assignable to this interface, so
 * `workersKvStore(env.PAYWRAP_KV)` just works in a Worker.
 */
export interface MinimalKVNamespace {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * ⚠️ Workers KV is NOT linearizable. This adapter implements mppx's
 * `AtomicStore` interface mechanically, but concurrent writers to the same
 * key can silently lose updates (KV's "last-write-wins" semantics over its
 * eventual-consistency window, up to ~60s globally).
 *
 * Safe for:
 * - **Charge-intent services** — challenge-id replay protection is the only
 *   shared state. Collisions within mppx's replay window are astronomically
 *   unlikely.
 * - **Low-concurrency session services** — single-user sessions where voucher
 *   accounting can't race itself.
 *
 * UNSAFE for:
 * - **Session-intent services with real concurrency** — two vouchers for the
 *   same channel arriving within KV's eventual-consistency window can corrupt
 *   `cumulativeAmount` accounting.
 *
 * For linearizable storage on Workers, use a Durable Object-backed store
 * (future work). This file is the cheap path for v1.
 *
 * Usage:
 * ```ts
 * // wrangler.toml
 * // [[kv_namespaces]]
 * // binding = "PAYWRAP_KV"
 * // id = "<your-namespace-id>"
 *
 * const store = workersKvStore(env.PAYWRAP_KV);
 * ```
 */
export const workersKvStore = (kv: MinimalKVNamespace) => Store.cloudflare(wrapKVForMppx(kv));

/**
 * Low-level wrapper exposed for advanced users who want to compose the KV
 * adapter with additional behavior (metrics, logging) before handing to
 * `Store.cloudflare`. Most consumers should use {@link workersKvStore}.
 */
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
	/**
	 * NON-ATOMIC read-compute-write. See file-level docblock: KV has no
	 * compare-and-swap, so concurrent writers to the same key can lose
	 * updates. Honest implementation over a fake atomicity wrapper.
	 */
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
