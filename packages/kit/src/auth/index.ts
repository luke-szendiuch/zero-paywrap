import { Challenge, type Credential } from "mppx";
import type { Hex } from "viem";
import type { MppxInstance, PaywrapMpp } from "../mpp/mppx.js";

// biome-ignore lint/suspicious/noExplicitAny: Credential is generic over payload
export type RawCredential = ReturnType<typeof Credential.deserialize<any>>;

/**
 * Branding symbol. Only the kit's `verifyWithScope` factory can produce a
 * `VerifiedCredential` — no external code can synthesize the symbol key. This
 * lets TypeScript reject any callsite that tries to hand a raw
 * `Credential.deserialize` result to a function that expects a verified one,
 * closing the footgun where a caller could forget the scope-verify step.
 */
export const VERIFIED: unique symbol = Symbol("paywrap.verified");

export type VerifiedCredential = {
	readonly [VERIFIED]: true;
	readonly credential: RawCredential;
};

/**
 * `source` on a proof credential is a `did:pkh` with the format
 * `did:pkh:eip155:<chainId>:<0x-address>`. This regex extracts the address.
 */
const PROOF_SOURCE_RE = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/;

/**
 * Read the CLAIMED payer address from a RAW (not-yet-verified) mppx credential.
 *
 * Unlike `payerFromCredential`, this does NOT require the credential to
 * have been verified — it's a best-effort hint suitable for pre-verify
 * lookups (e.g. to key an idempotency read on the wallet the client
 * claims before we pay to verify the claim).
 *
 * Two shapes:
 *
 *   1. `tempo.session` voucher — `payload.channelId` is present. Look up
 *      the channel in the store; if it exists, its recorded `payer` was
 *      validated by mppx at open-time. If the channel doesn't exist
 *      (mppx hasn't seen it yet), return `null` — we have no hint.
 *
 *   2. `tempo.charge` / proof — no `channelId`. Parse `credential.source`
 *      as a `did:pkh`; this is the address the buyer is CLAIMING to hold.
 *      The claim is not yet proven (that's what verify does), but for a
 *      pre-check lookup it's enough.
 *
 * SECURITY: the returned address is NOT authoritative. Use it only to
 * structure pre-verify work (e.g. database reads keyed on wallet) that
 * the subsequent `verifyWithScope` call will validate. Never make a
 * commitment (settle, charge, grant) based on this value alone.
 */
export const claimedPayerFromRawCredential = async (
	channelStore: PaywrapMpp["channelStore"],
	credential: RawCredential,
): Promise<Hex | null> => {
	const payload = credential.payload as { channelId?: Hex; type?: string };
	if (payload?.channelId) {
		try {
			const state = await channelStore.getChannel(payload.channelId);
			if (!state) return null;
			return state.payer.toLowerCase() as Hex;
		} catch {
			return null;
		}
	}
	const source = credential.source;
	if (typeof source !== "string") return null;
	const match = PROOF_SOURCE_RE.exec(source);
	if (!match || !match[1]) return null;
	return match[1].toLowerCase() as Hex;
};

/**
 * Read the payer address from a verified mppx credential. Two shapes:
 *
 *   1. `tempo.session` voucher — `payload.channelId` identifies the open
 *      channel. We look it up in mppx's store; the `payer` there was set
 *      when mppx verified the original open signature, proving the caller
 *      holds the signing key. Paid path (POST / extend).
 *
 *   2. `tempo.charge` proof — no channel, but mppx already verified the
 *      EIP-712 `Proof(challengeId)` signature against `credential.source`
 *      (a `did:pkh`). The address is trustworthy because mppx already
 *      checked signature + HMAC-bound challenge id + scope before this
 *      function runs. Free path (GET / DELETE).
 *
 * Contract: caller MUST have already run `mppx.verifyCredential(credential)`
 * and received back a verified object. Do not recover from raw signatures —
 * that bypasses mppx's HMAC challenge binding and scope enforcement.
 */
export const payerFromCredential = async (
	channelStore: PaywrapMpp["channelStore"],
	verified: VerifiedCredential,
): Promise<Hex | null> => {
	const credential = verified.credential;
	const payload = credential.payload as { channelId?: Hex; type?: string };
	if (payload?.channelId) {
		try {
			const state = await channelStore.getChannel(payload.channelId);
			if (!state) return null;
			return state.payer.toLowerCase() as Hex;
		} catch {
			return null;
		}
	}
	const source = credential.source;
	if (typeof source !== "string") return null;
	const match = PROOF_SOURCE_RE.exec(source);
	if (!match || !match[1]) return null;
	return match[1].toLowerCase() as Hex;
};

/**
 * HTTP-response descriptor. Framework adapters map this onto their reply API.
 * Kept deliberately dumb — no framework types leak into the kit.
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

/**
 * Shared wrapper for challenge builders. Invokes `fn()` to produce the
 * mppx challenge, serializes it into a 402 `ChallengeResponse`, and
 * converts any throw into a `ChallengeErrorResponse` with a stable
 * `challenge_generation_failed` error code.
 *
 * Keeping the envelope in one place means the three public builders
 * differ only in the one line that asks mppx for the underlying
 * challenge.
 */
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
 * Build a 402 `tempo.session` challenge — the paid path. Call this from
 * paid routes when the request arrives without a valid credential. The
 * client opens a channel (the voucher covers `amount`) and retries.
 *
 * `scope` is HMAC-bound into the challenge id, so a credential signed for
 * one scope cannot be replayed against another route that requires a
 * different scope.
 *
 * `amount` is passed through to mppx as-is. mppx's session method expects
 * a HUMAN-decimal string (e.g. `"0.02"` for 2 cents USDC) — it calls
 * `parseUnits(amount, decimals)` internally. If you have raw micro units,
 * format with `formatUnits(micro, 6)` before passing.
 *
 * `suggestedDeposit` is the amount the client should fund the channel
 * with — typically equal to `amount` for one-request services, higher for
 * multi-request sessions. Surfaced on the 402 body so clients know how
 * much to escrow. Defaults to `amount`.
 *
 * `unitType` mirrors mppx's `tempo.session` `unitType` option (defaults
 * to `"request"` at method registration; passing here is usually
 * redundant but supported for per-challenge overrides).
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
 * Build a 402 `tempo.charge` challenge — the single-shot paid path. Client
 * signs a proof bound to a non-zero `amount` and mppx settles that amount
 * immediately on verify. No channel, no voucher accounting. Suitable for
 * one-request-one-charge services that don't need session semantics.
 *
 * `scope` is HMAC-bound into the challenge id for the same replay-safety
 * reason as `buildSessionChallenge`.
 *
 * `amount` is passed through to mppx. mppx's charge method accepts a
 * HUMAN-decimal string (e.g. `"0.02"` — it parses via `parseUnits`). A
 * `bigint` flows through via `.toString()` which sellers can use when they
 * keep their own units. For zero-amount (pure proof-of-wallet) challenges
 * use `buildProofChallenge` instead — it's the documented name for that
 * flow.
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
 * Build a 402 `tempo.charge` challenge with `amount="0"` — the "proof
 * credential" flow. Client signs `Proof(challengeId)` to prove they hold a
 * wallet, without moving funds or opening a channel. Used by read/delete
 * routes that need wallet-authz without payment.
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
