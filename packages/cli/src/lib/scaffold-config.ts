// Shape of all user choices collected by `paywrap create`. Templates consume
// this directly — keep it stable so adding a prompt doesn't silently reorder.

export type PaymentIntent = "session" | "charge";
/**
 * - `fastify` — Node, full bullmq/drizzle matrix.
 * - `hono-workers` — Cloudflare Workers via Hono. No bullmq, no drizzle;
 *   storage is in-memory (charge) or Workers KV (session).
 * - `none` — bring-your-own framework.
 */
export type HttpFramework = "fastify" | "hono-workers" | "none";
export type StorageChoice = "postgres-drizzle" | "none";
export type QueueChoice = "bullmq-redis" | "none";
export type HostingHint = "render" | "fly" | "railway" | "docker" | "skip";
/**
 * - `private-key` — service signs (required for session intent).
 * - `address-only` — service holds only an address. Only valid for charge
 *   intent; the buyer pays Tempo gas in USDC, so the seller wallet never
 *   needs a key on the service. See `createPaywrapMpp({ walletAddress })`.
 */
export type WalletMode = "private-key" | "address-only";

export type ScaffoldConfig = {
	targetDir: string;
	/** kebab-case; matches `package.json#name` and appears in SKU scope. */
	serviceName: string;
	intent: PaymentIntent;
	/** Human USDC units, e.g. "0.02". */
	priceUsdc: string;
	/** HMAC-bound into the challenge id (e.g. "my-svc:1"). */
	scope: string;
	/** Used by extend + health messaging. */
	durationSeconds: number;
	framework: HttpFramework;
	storage: StorageChoice;
	queue: QueueChoice;
	hosting: HostingHint;
	walletMode: WalletMode;
	generateWalletNow: boolean;
	/** Only populated when `generateWalletNow` is true. */
	wallet?: { privateKey: `0x${string}`; address: `0x${string}` };
	/** Populated if the user opts to prefund on session intent. */
	prefundTxHash?: `0x${string}`;
};

/**
 * `framework` constrains the rest of the config matrix. Workers builds
 * can't use Postgres/BullMQ; address-only mode only works for charge.
 * Centralized here so both the prompter and the templates apply the same
 * coercions.
 */
export const normalizeScaffoldConfig = (config: ScaffoldConfig): ScaffoldConfig => {
	const next = { ...config };
	if (next.framework === "hono-workers") {
		next.storage = "none";
		next.queue = "none";
		// v1: workers scaffold is charge-only. Session-on-Workers needs
		// `workersKvStore`, which isn't linearizable — that warning belongs
		// in a follow-up, not silently inside a scaffold.
		if (next.intent === "session") next.intent = "charge";
	}
	// Session intent always requires a signing key (seller signs openChannel).
	if (next.intent === "session") {
		next.walletMode = "private-key";
	}
	return next;
};
