import { Challenge, Credential, Expires } from "mppx";
import { type Address, type Hex, bytesToHex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { TEMPO_CHAIN_ID, TEMPO_USDC, USDC_DECIMALS } from "../mpp/constants.js";

// Voucher EIP-712 domain. Mirrors mppx's `tempo/session/Voucher.js`
// — duplicated here so buyer-side clients + test fixtures can produce a
// signed voucher without round-tripping through an open-transaction.
const VOUCHER_DOMAIN_NAME = "Tempo Stream Channel";
const VOUCHER_DOMAIN_VERSION = "1";
const VOUCHER_TYPES = {
	Voucher: [
		{ name: "channelId", type: "bytes32" },
		{ name: "cumulativeAmount", type: "uint128" },
	],
} as const;

// mppx serializes `scope` under this reserved key in the challenge's opaque
// map. Setting it here keeps buyer-built credentials compatible with
// server-side scope checks.
const MPPX_SCOPE_KEY = "_mppx_scope";

/** Deterministic 32-byte channel id from a string label — test helper. */
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

/** Sign a Tempo session voucher. Buyer-side clients + test fixtures. */
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
	/** HMAC secret matching server's `MPP_SECRET_KEY`. */
	secretKey: string;
	/** Scope matching the paid route's configured scope. */
	scope: string;
	meta?: Record<string, string>;
	expires?: ReturnType<typeof Expires.minutes>;
	currency?: Address;
	decimals?: number;
};

/**
 * Build a serialized `Payment <...>` Authorization header carrying a signed
 * voucher credential. Return value is the FULL header value (includes the
 * `Payment ` prefix) — pass as-is to `authorization:`. Do NOT wrap in another
 * `"Payment "`.
 */
export const buildVoucherCredential = async (
	params: BuildVoucherCredentialParams,
): Promise<string> => {
	const signature = await signVoucher(params);
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

// Proof-credential EIP-712 domain. Mirrors `mppx/dist/tempo/internal/proof.js`.
const PROOF_DOMAIN_NAME = "MPP";
const PROOF_DOMAIN_VERSION = "1";
const PROOF_TYPES = {
	Proof: [{ name: "challengeId", type: "string" }],
} as const;

export type BuildChargeCredentialParams = {
	payer: PrivateKeyAccount;
	recipient: Address;
	chainId?: number;
	/** Micro units. 0 → proof; >0 → paid charge (verifiable only with `stubVerifyCredential`). */
	amountMicro: bigint;
	/** Must match server realm (derived from `PUBLIC_BASE_URL` host). */
	realm: string;
	secretKey: string;
	scope: string;
	meta?: Record<string, string>;
	expires?: ReturnType<typeof Expires.minutes>;
	currency?: Address;
	decimals?: number;
};

/**
 * Build a serialized `Payment <...>` header carrying a signed `tempo.charge`
 * proof credential. Mirrors what `mppx/client`'s charge method produces on
 * the zero-amount path.
 *
 * Semantics:
 *   - `amountMicro === 0n` → pure proof credential. Verifies end-to-end
 *     against a real `mppx.verifyCredential`.
 *   - `amountMicro > 0n` → proof-shaped credential; server-side charge
 *     verify REQUIRES an on-chain `hash`/`transaction` credential for
 *     non-zero amounts, so this path fails against a real chain. Pair with
 *     `stubVerifyCredential` from `@zeroclickai/paywrap/testing` in tests.
 */
export const buildChargeCredential = async (
	params: BuildChargeCredentialParams,
): Promise<string> => {
	const chainId = params.chainId ?? TEMPO_CHAIN_ID;
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
