import { Challenge, Credential } from "mppx";
import type { Hex } from "viem";
import type { MppxInstance, PaywrapMpp } from "../mpp/mppx.js";

// biome-ignore lint/suspicious/noExplicitAny: Credential is generic over payload
export type RawCredential = ReturnType<typeof Credential.deserialize<any>>;

/**
 * Branding symbol. Only `verifyWithScope` can produce a `VerifiedCredential`,
 * so TypeScript rejects any callsite that hands a raw credential to a helper
 * expecting a verified one — the scope-verify step can't be skipped.
 */
export const VERIFIED: unique symbol = Symbol("paywrap.verified");

export type VerifiedCredential = {
	readonly [VERIFIED]: true;
	readonly credential: RawCredential;
};

/** `did:pkh:eip155:<chainId>:<0x-address>` — address group = 1. */
const PROOF_SOURCE_RE = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/;

// Shared payer-resolution. For session vouchers the channel store is the source
// of truth (mppx recorded the verified payer at open-time). For charge/proof
// credentials, the signer did:pkh is carried on `credential.source`.
const resolvePayer = async (
	channelStore: PaywrapMpp["channelStore"],
	credential: RawCredential,
): Promise<Hex | null> => {
	const payload = credential.payload as { channelId?: Hex };
	if (payload?.channelId) {
		try {
			const state = await channelStore.getChannel(payload.channelId);
			return state ? (state.payer.toLowerCase() as Hex) : null;
		} catch {
			return null;
		}
	}
	const source = credential.source;
	if (typeof source !== "string") return null;
	const match = PROOF_SOURCE_RE.exec(source);
	return match?.[1] ? (match[1].toLowerCase() as Hex) : null;
};

/**
 * Best-effort CLAIMED payer from a RAW (unverified) credential. Use only to
 * structure pre-verify work (e.g. DB reads). NEVER commit (settle, charge,
 * grant) based on this — the subsequent `verifyWithScope` does that.
 */
export const claimedPayerFromRawCredential = resolvePayer;

/**
 * Payer address from a VERIFIED credential. Caller MUST have run
 * `verifyWithScope` first — do not recover from raw signatures, that bypasses
 * mppx's HMAC challenge binding + scope enforcement.
 */
export const payerFromCredential = (
	channelStore: PaywrapMpp["channelStore"],
	verified: VerifiedCredential,
): Promise<Hex | null> => resolvePayer(channelStore, verified.credential);

/**
 * HTTP-response descriptor. Framework adapters map this onto their reply API.
 * No framework types leak into the kit.
 */
export type ChallengeResponse = {
	status: 402;
	headers: Record<string, string>;
	// biome-ignore lint/suspicious/noExplicitAny: Challenge is generic over method
	body: { challenge: any; detail: string };
};

export type ChallengeErrorResponse = {
	status: 500;
	headers: Record<string, string>;
	body: { error: string; reason: string };
};

const tryBuildChallenge = async (
	detail: string,
	// biome-ignore lint/suspicious/noExplicitAny: Challenge is generic over method
	fn: () => Promise<any>,
): Promise<ChallengeResponse | ChallengeErrorResponse> => {
	try {
		const challenge = await fn();
		return {
			status: 402,
			headers: { "www-authenticate": Challenge.serialize(challenge) },
			body: { challenge, detail },
		};
	} catch (err) {
		return {
			status: 500,
			headers: {},
			body: {
				error: "challenge_generation_failed",
				reason: err instanceof Error ? err.message : String(err),
			},
		};
	}
};

/**
 * 402 `tempo.session` challenge (paid, channel-based). `amount` is HUMAN
 * decimal (mppx calls `parseUnits(amount, decimals)`). `suggestedDeposit`
 * defaults to `amount`. `scope` is HMAC-bound into the challenge id.
 */
export const buildSessionChallenge = (
	mppx: MppxInstance,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
		suggestedDeposit?: bigint | string;
		unitType?: string;
	},
): Promise<ChallengeResponse | ChallengeErrorResponse> =>
	tryBuildChallenge(opts.detail, () =>
		mppx.challenge.tempo.session({
			amount: opts.amount.toString(),
			suggestedDeposit: (opts.suggestedDeposit ?? opts.amount).toString(),
			...(opts.unitType !== undefined ? { unitType: opts.unitType } : {}),
			scope: opts.scope,
			...(opts.meta ? { meta: opts.meta } : {}),
		}),
	);

/**
 * 402 `tempo.charge` challenge (paid, single-shot — atomic settle, no channel).
 * `amount` is HUMAN decimal. For amount=0 (proof of wallet) use
 * `buildProofChallenge`.
 */
export const buildChargeChallenge = (
	mppx: MppxInstance,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
): Promise<ChallengeResponse | ChallengeErrorResponse> =>
	tryBuildChallenge(opts.detail, () =>
		mppx.challenge.tempo.charge({
			amount: opts.amount.toString(),
			scope: opts.scope,
			...(opts.meta ? { meta: opts.meta } : {}),
		}),
	);

/**
 * 402 `tempo.charge` with `amount="0"` — "proof credential" flow. Client signs
 * `Proof(challengeId)` to prove wallet control without moving funds.
 */
export const buildProofChallenge = (
	mppx: MppxInstance,
	opts: { scope: string; detail: string; meta?: Record<string, string> },
): Promise<ChallengeResponse | ChallengeErrorResponse> =>
	tryBuildChallenge(opts.detail, () =>
		mppx.challenge.tempo.charge({
			amount: "0",
			scope: opts.scope,
			...(opts.meta ? { meta: opts.meta } : {}),
		}),
	);

/**
 * Parse a `Payment` / `Authorization` header into an mppx credential. Accepts
 * either the full `Payment <base64url>` form or a bare base64url value.
 * Returns `null` on any parse failure (route should respond 402, not 400 —
 * credential shape is part of the 402 contract).
 *
 * Framework-agnostic: safe for Cloudflare Workers.
 */
export const extractCredential = (header: string | undefined): RawCredential | null => {
	if (!header) return null;
	try {
		return Credential.deserialize(header.startsWith("Payment ") ? header : `Payment ${header}`);
	} catch {
		return null;
	}
};

/**
 * Stable fingerprint of a serialized `Payment ...` Authorization header.
 * Used as a charge-intent idempotency key: two retries of the same paid
 * request share a fingerprint, so consumer code can deduplicate
 * post-settlement work (e.g. don't double-create a Netlify site / Daytona
 * sandbox if a network-partitioned client retries with the same credential).
 *
 * SHA-256 via Web Crypto so it runs identically on Node and Cloudflare
 * Workers without the `node:crypto` import. Returns the full 64-char hex
 * digest; consumers typically slice the first 8-16 chars for compact ids.
 *
 * The header is normalized (`Payment ` prefix added if missing) so the
 * `Authorization:` and `Payment:` header forms produce the same digest.
 */
/**
 * Server-side payload that becomes the `Payment-Receipt` header on a paid
 * session-intent 200 response. The CLI decodes this to learn the actual
 * settled amount on the channel; without it the buyer would close at the
 * full deposit (overpaying for unused capacity).
 *
 * - `acceptedCumulative` / `spent`: ABSOLUTE (not delta) cumulative on the
 *   channel after this request. For the single-request session pattern
 *   `mppx.fetch` produces today (open → 1 request → close), `prev = 0` so
 *   both fields equal the actual amount charged.
 * - `channelId`: the voucher's channel — read from `credential.payload.channelId`.
 * - `challengeId`: the original 402 challenge id — read from `credential.challenge.id`.
 *
 * Wire format: base64url(JSON.stringify(payload)). `URLSearchParams` /
 * `Buffer.from(..., 'base64')` MUST be tolerant to omitted padding — the CLI's
 * `decodeSessionReceiptHeader` re-pads, so we strip `=` here for cleanliness
 * and parity with how the CLI sends bytes back.
 */
export type SessionReceiptPayload = {
	channelId: string;
	challengeId: string;
	acceptedCumulative: string;
	spent: string;
	txHash?: string;
};

const utf8 = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Encode a settlement receipt for the `Payment-Receipt` HTTP response header
 * on session-intent paid responses. Pair with `mppMetered()` (hono adapter)
 * which calls this after the handler computes the actual amount.
 *
 * Web-Crypto-friendly: base64url via `btoa` + character-mapping, no
 * `Buffer` / `node:crypto` — runs identically on Node and Cloudflare Workers.
 *
 * Round-trip-tested against the Zero CLI's `decodeSessionReceiptHeader`.
 */
export const encodeSessionReceipt = (payload: SessionReceiptPayload): string => {
	const json = JSON.stringify(payload);
	return base64UrlEncode(utf8.encode(json));
};

export const fingerprintCredential = async (header: string): Promise<string> => {
	const normalized = header.startsWith("Payment ") ? header : `Payment ${header}`;
	const data = new TextEncoder().encode(normalized);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};
