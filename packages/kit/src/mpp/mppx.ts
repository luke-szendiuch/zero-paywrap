import { Mppx, Store, tempo } from "mppx/server";
import { Session } from "mppx/tempo";
import { http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoChain } from "./chain.js";
import { TEMPO_ESCROW, TEMPO_USDC, USDC_DECIMALS } from "./constants.js";

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
	/** Channel-state store. Use `redisStore(...)` in prod, `memoryStore()` in tests. */
	store: AnyStore;
	/**
	 * Override mppx's in-memory on-chain cache TTL. Production keeps the short
	 * 5s default so force-close detection stays responsive. Tests usually pass
	 * `Number.POSITIVE_INFINITY` so verification reads only from seeded state.
	 */
	channelStateTtl?: number;
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

	const sharedMethodConfig = {
		store: config.store,
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

	const channelStore = Session.ChannelStore.fromStore(config.store);

	return { mppx, channelStore, account, client };
};

export { Store };
