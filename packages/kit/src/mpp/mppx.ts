import { Mppx, tempo } from "mppx/server";
import { Session } from "mppx/tempo";
import { http, createWalletClient } from "viem";
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

export type CreateMppxConfig = {
	/** `0x`-prefixed private key for the seller wallet. */
	walletPrivateKey: `0x${string}`;
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

export type PaywrapMpp = {
	mppx: MppxInstance;
	channelStore: ReturnType<typeof Session.ChannelStore.fromStore>;
	account: ReturnType<typeof privateKeyToAccount>;
	client: ReturnType<typeof createWalletClient>;
	/** Optional logger configured at factory time; adapters consume this. */
	logger?: LoggerCallback;
};

/**
 * Build an mppx instance configured for Tempo with both `session` and `charge`
 * methods registered.
 *
 *   - `session` — 402 channel-open invitations + settle vouchers on open
 *     channels. Paid routes.
 *   - `charge` with `amount="0"` — proof-credential flow (signer address on
 *     `credential.source`). Wallet auth on GET/DELETE.
 *
 * Both are realm-bound + HMAC-signed via `mppSecretKey` → credentials verify
 * statelessly.
 */
export const createPaywrapMpp = (config: CreateMppxConfig): PaywrapMpp => {
	const account = privateKeyToAccount(config.walletPrivateKey);
	const client = createWalletClient({
		account,
		chain: tempoChain,
		transport: http(config.tempoRpcUrl),
	});

	const store = config.store ?? resolveDefaultStore();
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
		realm: new URL(config.publicBaseUrl).host,
		secretKey: config.mppSecretKey,
	});

	const channelStore = Session.ChannelStore.fromStore(store);

	return {
		mppx,
		channelStore,
		account,
		client,
		...(config.logger ? { logger: config.logger } : {}),
	};
};
