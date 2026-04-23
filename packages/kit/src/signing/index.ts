import { Challenge, Credential, Expires } from "mppx";
import { type Address, type Hex, bytesToHex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { TEMPO_USDC, USDC_DECIMALS } from "../mpp/constants.js";

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
