import { Mppx, tempo } from "mppx/server";
import { Session } from "mppx/tempo";
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LoggerCallback } from "../logger/index.js";
import { tempoChain } from "./chain.js";
import { TEMPO_ESCROW, TEMPO_USDC, USDC_DECIMALS } from "./constants.js";
import { memoryStore, redisStore } from "./stores.js";

// `any` is load-bearing: the inferred return type of `Mppx.create({...})`
// drags half of mppx's internals into the emitted .d.ts ("cannot be named
// without reference to ..."). We only call runtime handlers, so `any` is fine.
// biome-ignore lint/suspicious/noExplicitAny: mppx handler type explodes
export type MppxInstance = any;

// biome-ignore lint/suspicious/noExplicitAny: see MppxInstance
type AnyStore = any;

/**
 * Wallet config — pick exactly one:
 *
 *   - `walletPrivateKey` (full mode) — registers both `tempo.session` and
 *     `tempo.charge`. Required for session intent (server signs `openChannel`
 *     / `closeChannel`) and for `feePayer: true` charge variants where the
 *     seller sponsors the buyer's gas.
 *
 *   - `walletAddress` (address-only mode) — registers `tempo.charge` only.
 *     Charge intent broadcasts the *buyer-signed* raw tx via
 *     `eth_sendRawTransaction`, so the seller never holds a key. Use this
 *     for stateless charge-intent / proof services to avoid provisioning a
 *     wallet secret per deployment. Calling `mppGated({ intent: "session" })`
 *     against an address-only `mppx` will fail with a clear error.
 */
export type PaywrapWalletConfig =
	| { walletPrivateKey: `0x${string}`; walletAddress?: never }
	| { walletAddress: `0x${string}`; walletPrivateKey?: never };

export type PaywrapMppCommonConfig = {
	/** Public URL of this service. Host becomes the MPP realm. */
	publicBaseUrl: string;
	/** HMAC secret that binds challenge ids to this server. Min 32 bytes. */
	mppSecretKey: string;
	tempoRpcUrl: string;
	/**
	 * Channel-state store. Optional: defaults to Redis (db=9) when
	 * `process.env.REDIS_URL` is set + `ioredis` is installed, else an
	 * in-memory store with a one-shot warning.
	 */
	store?: AnyStore;
	/**
	 * mppx's on-chain cache TTL. Production keeps the 5s default so
	 * force-close detection stays responsive; tests pass
	 * `Number.POSITIVE_INFINITY` to verify against seeded state only.
	 *
	 * Ignored in address-only mode (no session method registered).
	 */
	channelStateTtl?: number;
	/**
	 * Optional structured-event logger. Adapters (`mppGated`) emit
	 * `payment_required`, `payment_settled`, `payment_failed`, and
	 * `request_completed` events through this callback. Sink-agnostic
	 * — see `@zeroclickai/paywrap/logger` for the event taxonomy and
	 * the `consoleJsonLogger` default.
	 */
	logger?: LoggerCallback;
};

export type CreateMppxConfig = PaywrapMppCommonConfig & PaywrapWalletConfig;

let warnedDefaultStore = false;

const resolveDefaultStore = (): AnyStore => {
	const redisUrl = typeof process !== "undefined" ? process.env?.REDIS_URL : undefined;
	if (redisUrl) {
		try {
			// createRequire so ioredis isn't pulled in at module-load for
			// consumers who never enable Redis.
			const { createRequire } = require("node:module") as typeof import("node:module");
			const req = createRequire(import.meta.url);
			const mod = req("ioredis");
			const IORedis = mod.default ?? mod.Redis ?? mod;
			if (typeof IORedis !== "function") {
				throw new Error("ioredis export is not a constructor");
			}
			const redis = new IORedis(redisUrl, { db: 9, maxRetriesPerRequest: null });
			if (!warnedDefaultStore) {
				console.warn("paywrap: no `store` provided — connecting to Redis via REDIS_URL (db=9).");
				warnedDefaultStore = true;
			}
			return redisStore(redis);
		} catch (err) {
			if (!warnedDefaultStore) {
				console.warn(
					`paywrap: REDIS_URL set but ioredis unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to in-memory store. State will be lost on restart.`,
				);
				warnedDefaultStore = true;
			}
			return memoryStore();
		}
	}
	if (!warnedDefaultStore) {
		console.warn("paywrap: no REDIS_URL — using in-memory store. State will be lost on restart.");
		warnedDefaultStore = true;
	}
	return memoryStore();
};

/**
 * Default paywrap-mpp bundle shape — the basic, charge-capable seller
 * primitives. `walletAddress` is always populated; the buyer signs every
 * Tempo tx so the seller never needs to hold a private key for charge or
 * proof intents. Most paid services hold a value of this type.
 *
 * Session intent and `feePayer: true` charge require a signer — see
 * `PaywrapMppKeyed`, which structurally extends `PaywrapMpp` with the
 * signing fields. Helpers that perform on-chain writes (e.g.
 * `closeSessionOnChain`) require `PaywrapMppKeyed` explicitly.
 */
export type PaywrapMpp = {
	mppx: MppxInstance;
	channelStore: ReturnType<typeof Session.ChannelStore.fromStore>;
	/** Seller recipient address — always present in both modes. */
	walletAddress: `0x${string}`;
	logger?: LoggerCallback;
};

/**
 * Paywrap-mpp bundle that carries a signer (built from `walletPrivateKey`).
 * Required for session intent (`openChannel` / `closeChannel` writes),
 * `closeSessionOnChain` and metered close helpers, and `feePayer: true`
 * charge variants where the seller sponsors buyer gas.
 *
 * Structurally a superset of `PaywrapMpp`: a `PaywrapMppKeyed` value is
 * assignable to anything that takes `PaywrapMpp`. The reverse is not
 * true — a non-keyed bundle can't be used where a signer is required.
 */
export type PaywrapMppKeyed = PaywrapMpp & {
	/** Signing account derived from `walletPrivateKey`. */
	account: ReturnType<typeof privateKeyToAccount>;
	/** Tempo wallet client (signs + sends txs). */
	client: ReturnType<typeof createWalletClient>;
};

/**
 * Build an mppx instance configured for Tempo.
 *
 *   - **Default mode** (`walletAddress`) — registers `tempo.charge`
 *     only. Charge intent broadcasts the buyer-signed raw tx, so the
 *     seller never needs a key. Use for stateless charge / proof
 *     services. Returns `PaywrapMpp`.
 *
 *   - **Keyed mode** (`walletPrivateKey`) — registers `tempo.session`
 *     AND `tempo.charge`. Required for session intent (server signs
 *     openChannel/closeChannel), metered close helpers, and
 *     `feePayer: true` charge variants. Returns `PaywrapMppKeyed`,
 *     which extends `PaywrapMpp` with `account` + `client`.
 *
 * Both modes are realm-bound + HMAC-signed via `mppSecretKey` →
 * credentials verify statelessly.
 */
export function createPaywrapMpp(
	config: PaywrapMppCommonConfig & { walletPrivateKey: `0x${string}` },
): PaywrapMppKeyed;
export function createPaywrapMpp(
	config: PaywrapMppCommonConfig & { walletAddress: `0x${string}` },
): PaywrapMpp;
export function createPaywrapMpp(config: CreateMppxConfig): PaywrapMpp;
export function createPaywrapMpp(config: CreateMppxConfig): PaywrapMpp {
	const store = config.store ?? resolveDefaultStore();
	const realm = new URL(config.publicBaseUrl).host;
	const channelStore = Session.ChannelStore.fromStore(store);

	if (config.walletPrivateKey !== undefined) {
		const account = privateKeyToAccount(config.walletPrivateKey);
		const client = createWalletClient({
			account,
			chain: tempoChain,
			transport: http(config.tempoRpcUrl),
		});
		const sharedMethodConfig = {
			store,
			currency: TEMPO_USDC,
			decimals: USDC_DECIMALS,
			account,
			recipient: account.address,
			getClient: () => client,
		};
		const mppx = Mppx.create({
			methods: [
				tempo.session({
					...sharedMethodConfig,
					escrowContract: TEMPO_ESCROW,
					unitType: "request",
					...(config.channelStateTtl !== undefined
						? { channelStateTtl: config.channelStateTtl }
						: {}),
				}),
				tempo.charge(sharedMethodConfig),
			],
			realm,
			secretKey: config.mppSecretKey,
		});
		// Type as the keyed superset so the literal carries `account` + `client`;
		// `PaywrapMppKeyed` is assignable to the implementation's `PaywrapMpp`
		// return type via structural subsumption.
		const keyed: PaywrapMppKeyed = {
			mppx,
			channelStore,
			walletAddress: account.address,
			account,
			client,
			...(config.logger ? { logger: config.logger } : {}),
		};
		return keyed;
	}

	if (config.walletAddress === undefined) {
		throw new Error(
			"createPaywrapMpp: must provide either `walletPrivateKey` (keyed mode: session + charge + feePayer-true charge) or `walletAddress` (default mode: charge + proof). Neither was supplied.",
		);
	}

	// Read-only public client — `eth_sendRawTransaction` does not need a signer,
	// so the buyer-signed raw tx in a charge credential broadcasts fine through
	// a `PublicClient`. No funding, no key, no exposure surface for the seller.
	const publicClient = createPublicClient({
		chain: tempoChain,
		transport: http(config.tempoRpcUrl),
	});
	const mppx = Mppx.create({
		methods: [
			tempo.charge({
				store,
				currency: TEMPO_USDC,
				decimals: USDC_DECIMALS,
				recipient: config.walletAddress,
				// biome-ignore lint/suspicious/noExplicitAny: mppx getClient expects WalletClient or compatible; PublicClient satisfies the runtime contract for charge (read + sendRawTransaction).
				getClient: () => publicClient as any,
			}),
		],
		realm,
		secretKey: config.mppSecretKey,
	});
	return {
		mppx,
		channelStore,
		walletAddress: config.walletAddress,
		...(config.logger ? { logger: config.logger } : {}),
	};
}
