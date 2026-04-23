import { Mppx, tempo } from "mppx/server";
import { Session } from "mppx/tempo";
import { http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoChain } from "./chain.js";
import { TEMPO_ESCROW, TEMPO_USDC, USDC_DECIMALS } from "./constants.js";
import { memoryStore, redisStore } from "./stores.js";

// `any` here is load-bearing: the inferred return type of `Mppx.create({
// methods: [tempo.session(...)] })` drags half of mppx's internals into the
// emitted .d.ts and TS gives up ("cannot be named without reference to ...").
// We only call the runtime handlers, so `any` is fine here.
// biome-ignore lint/suspicious/noExplicitAny: mppx handler type explodes
export type MppxInstance = any;

// biome-ignore lint/suspicious/noExplicitAny: see MppxInstance
type AnyStore = any;

export type CreateMppxConfig = {
	/** `0x`-prefixed private key for the seller wallet. Signs on-chain txs. */
	walletPrivateKey: `0x${string}`;
	/** Public URL of this service. Used as the MPP realm. Must have a hostname. */
	publicBaseUrl: string;
	/** HMAC secret that binds challenge ids to this server. Min 32 bytes. */
	mppSecretKey: string;
	/** Tempo RPC URL (e.g. `https://rpc.tempo.xyz`). */
	tempoRpcUrl: string;
	/**
	 * Channel-state store. Optional: when omitted, the kit picks a default —
	 * if `process.env.REDIS_URL` is set AND `ioredis` is installed we connect
	 * to Redis (logical db=9), otherwise we fall back to a lossy in-memory
	 * store and emit a one-shot warning via `console.warn`. Pass an explicit
	 * store (memoryStore / redisStore / custom) to opt out of the default.
	 */
	store?: AnyStore;
	/**
	 * Override mppx's in-memory on-chain cache TTL. Production keeps the short
	 * 5s default so force-close detection stays responsive. Tests usually pass
	 * `Number.POSITIVE_INFINITY` so verification reads only from seeded state.
	 */
	channelStateTtl?: number;
};

// One-shot warning so the in-memory fallback is visible in logs without
// spamming every createPaywrapMpp call (eg. worker + web processes both
// construct an instance).
let warnedDefaultStore = false;

/**
 * Resolve the default channel-state store synchronously. Used when the
 * caller omits `config.store` from `createPaywrapMpp`.
 *
 * If `process.env.REDIS_URL` is set AND `ioredis` resolves at runtime, we
 * connect to Redis on logical db=9. Otherwise we fall back to an in-memory
 * store and emit a one-shot warning.
 *
 * We use `require()` via `createRequire` so ioredis is NOT pulled in at
 * module-load time for consumers who don't need it — the plan requires
 * this to avoid forcing ioredis on consumers who don't want it.
 */
const resolveDefaultStore = (): AnyStore => {
	const redisUrl = typeof process !== "undefined" ? process.env?.REDIS_URL : undefined;
	if (redisUrl) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
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
};

/**
 * Build an mppx instance configured for Tempo with both `session` (paid) and
 * `charge` (proof-credential) methods registered.
 *
 * - `session` issues 402 channel-open invitations AND settles vouchers posted
 *   against an already-open channel. Used for paid routes.
 * - `charge` with `amount="0"` is the "proof credential" flow — the client
 *   signs `Proof(challengeId)` and the signer address surfaces on
 *   `credential.source`. Used for free wallet-auth on GET/DELETE routes.
 *
 * Both are realm-bound and HMAC-signed via `mppSecretKey` so credentials
 * verify statelessly.
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

	return { mppx, channelStore, account, client };
};
