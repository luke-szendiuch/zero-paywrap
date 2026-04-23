// Shape of all user choices collected by `paywrap create`. Templates consume
// this directly — keep it stable so adding a prompt doesn't silently reorder.

export type PaymentIntent = "session" | "charge";
export type HttpFramework = "fastify" | "none";
export type StorageChoice = "postgres-drizzle" | "none";
export type QueueChoice = "bullmq-redis" | "none";
export type HostingHint = "render" | "fly" | "railway" | "docker" | "skip";

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
	generateWalletNow: boolean;
	/** Only populated when `generateWalletNow` is true. */
	wallet?: { privateKey: `0x${string}`; address: `0x${string}` };
	/** Populated if the user opts to prefund on session intent. */
	prefundTxHash?: `0x${string}`;
};
