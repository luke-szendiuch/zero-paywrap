import { Challenge, Credential, Expires } from "mppx";
import { type Address, type Hex, bytesToHex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { TEMPO_CHAIN_ID, TEMPO_USDC, USDC_DECIMALS } from "../mpp/constants.js";

/**
 * Voucher EIP-712 domain. Mirrors mppx's internal `tempo/session/Voucher.js`
 * — kept duplicated here so buyer-side clients and test fixtures can
 * produce a signed voucher without a round-trip through an open-transaction.
 */
const VOUCHER_DOMAIN_NAME = "Tempo Stream Channel";
const VOUCHER_DOMAIN_VERSION = "1";
const VOUCHER_TYPES = {
	Voucher: [
		{ name: "channelId", type: "bytes32" },
		{ name: "cumulativeAmount", type: "uint128" },
	],
} as const;

/** Deterministic 32-byte channel id from a string label — useful in tests. */
export const channelIdFromLabel = (label: string): Hex => {
	const bytes = new TextEncoder().encode(label);
	const padded = new Uint8Array(32);
	padded.set(bytes.slice(0, 32));
	return bytesToHex(padded);
};

export type SignVoucherParams = {
	payer: PrivateKeyAccount;
	channelId: Hex;
	cumulativeAmount: bigint;
	escrowContract: Address;
	chainId: number;
};

/**
 * Sign a Tempo session voucher. Returns the hex signature. Both buyer-side
 * clients (the `zero` CLI) and test fixtures produce vouchers this way.
 */
export const signVoucher = async (params: SignVoucherParams): Promise<Hex> =>
	params.payer.signTypedData({
		domain: {
			name: VOUCHER_DOMAIN_NAME,
			version: VOUCHER_DOMAIN_VERSION,
			chainId: params.chainId,
			verifyingContract: params.escrowContract,
		},
		types: VOUCHER_TYPES,
		primaryType: "Voucher",
		message: {
			channelId: params.channelId,
			cumulativeAmount: params.cumulativeAmount,
		},
	});

export type BuildVoucherCredentialParams = SignVoucherParams & {
	recipient: Address;
	realm: string;
	/** HMAC secret matching the server's `MPP_SECRET_KEY`. */
	secretKey: string;
	/** Scope literal matching the paid route's configured scope. */
	scope: string;
	/** Extra opaque metadata; must match the route's `meta` option if set. */
	meta?: Record<string, string>;
	/** Challenge expiry; defaults to 5 minutes. */
	expires?: ReturnType<typeof Expires.minutes>;
	/** Currency address; defaults to USDC on Tempo. */
	currency?: Address;
	/** Currency decimals; defaults to 6 (USDC). */
	decimals?: number;
};

/**
 * Produce a serialized `Authorization: Payment <...>` header value carrying a
 * signed voucher credential. Useful for:
 *   - The `zero` CLI (buyer-side) to call a paid endpoint.
 *   - Integration tests to hit paid routes without standing up a real payer.
 *
 * Return value is the FULL Authorization header value, including the
 * `Payment ` prefix — pass it as-is:
 *   `fetch(url, { headers: { authorization: await buildVoucherCredential(...) } })`.
 * Do NOT wrap it in another `"Payment "`.
 *
 * mppx serializes `scope` under the reserved key `_mppx_scope` inside the
 * opaque meta map. We set it there so the server's scope check matches.
 */
export const buildVoucherCredential = async (
	params: BuildVoucherCredentialParams,
): Promise<string> => {
	const signature = await signVoucher(params);

	const MPPX_SCOPE_KEY = "_mppx_scope";
	const mergedOpaque: Record<string, string> = {
		...(params.meta ?? {}),
		[MPPX_SCOPE_KEY]: params.scope,
	};

	const challenge = Challenge.from({
		realm: params.realm,
		method: "tempo",
		intent: "session",
		expires: params.expires ?? Expires.minutes(5),
		request: {
			amount: params.cumulativeAmount.toString(),
			chainId: params.chainId,
			currency: params.currency ?? TEMPO_USDC,
			decimals: params.decimals ?? USDC_DECIMALS,
			escrowContract: params.escrowContract,
			recipient: params.recipient,
			unitType: "request",
		} as unknown as Record<string, unknown>,
		meta: mergedOpaque,
		secretKey: params.secretKey,
	});

	const credential = Credential.from({
		challenge,
		payload: {
			action: "voucher",
			channelId: params.channelId,
			cumulativeAmount: params.cumulativeAmount.toString(),
			signature,
		},
	});
	return Credential.serialize(credential);
};

/**
 * EIP-712 domain for tempo.charge proof credentials. Mirrors
 * `mppx/dist/tempo/internal/proof.js`. Kept duplicated so buyer-side
 * clients + tests can produce a signed proof without a round-trip
 * through an open challenge.
 */
const PROOF_DOMAIN_NAME = "MPP";
const PROOF_DOMAIN_VERSION = "1";
const PROOF_TYPES = {
	Proof: [{ name: "challengeId", type: "string" }],
} as const;

export type BuildChargeCredentialParams = {
	payer: PrivateKeyAccount;
	recipient: Address;
	chainId?: number;
	/** Micro units (6 decimals for USDC). 0 → proof credential; >0 → paid charge. */
	amountMicro: bigint;
	/** Must match the server's realm (derived from `PUBLIC_BASE_URL` host). */
	realm: string;
	/** HMAC secret matching the server's `MPP_SECRET_KEY`. */
	secretKey: string;
	/** Scope literal matching the paid route's configured scope. */
	scope: string;
	/** Extra opaque metadata; must match the route's `meta` option if set. */
	meta?: Record<string, string>;
	/** Challenge expiry; defaults to 5 minutes. */
	expires?: ReturnType<typeof Expires.minutes>;
	/** Currency address; defaults to USDC on Tempo. */
	currency?: Address;
	/** Currency decimals; defaults to 6 (USDC). */
	decimals?: number;
};

/**
 * Produce a serialized `Authorization: Payment <...>` header value carrying a
 * signed `tempo.charge` proof credential. Mirrors what `mppx/client`'s charge
 * method produces for the zero-amount (proof) path.
 *
 * Return value is the FULL Authorization header value, including the
 * `Payment ` prefix — pass it as-is:
 *   `fetch(url, { headers: { authorization: await buildChargeCredential(...) } })`.
 * Do NOT wrap it in another `"Payment "`.
 *
 * Semantics:
 *   - `amountMicro === 0n` → pure proof credential. Verifies end-to-end
 *     against a real `mppx.verifyCredential` call (no on-chain tx needed).
 *   - `amountMicro > 0n`   → proof-shaped credential. mppx's server-side
 *     charge verify REQUIRES an on-chain `hash`/`transaction` credential
 *     for non-zero amounts, so this path will fail verification against a
 *     real chain. In tests, pair with `stubVerifyCredential` from
 *     `@zerorun/paywrap/testing` to bypass on-chain settlement while still
 *     exercising every other adapter + kit code path.
 *
 * The scope goes under the reserved key `_mppx_scope` in the opaque meta
 * map so the server's scope check matches.
 */
export const buildChargeCredential = async (
	params: BuildChargeCredentialParams,
): Promise<string> => {
	const chainId = params.chainId ?? TEMPO_CHAIN_ID;
	const MPPX_SCOPE_KEY = "_mppx_scope";
	const mergedOpaque: Record<string, string> = {
		...(params.meta ?? {}),
		[MPPX_SCOPE_KEY]: params.scope,
	};

	const challenge = Challenge.from({
		realm: params.realm,
		method: "tempo",
		intent: "charge",
		expires: params.expires ?? Expires.minutes(5),
		request: {
			amount: params.amountMicro.toString(),
			currency: params.currency ?? TEMPO_USDC,
			decimals: params.decimals ?? USDC_DECIMALS,
			recipient: params.recipient,
			methodDetails: { chainId },
		} as unknown as Record<string, unknown>,
		meta: mergedOpaque,
		secretKey: params.secretKey,
	});

	// Sign `Proof(challengeId)` — same EIP-712 shape the mppx client uses
	// on the zero-amount branch.
	const signature = await params.payer.signTypedData({
		domain: {
			name: PROOF_DOMAIN_NAME,
			version: PROOF_DOMAIN_VERSION,
			chainId,
		},
		types: PROOF_TYPES,
		primaryType: "Proof",
		message: { challengeId: challenge.id },
	});

	const credential = Credential.from({
		challenge,
		payload: { signature, type: "proof" as const },
		source: `did:pkh:eip155:${chainId}:${params.payer.address}`,
	});
	return Credential.serialize(credential);
};
