import { Challenge, Credential } from "mppx";
import type { Hex } from "viem";
import type { MppxInstance, PaywrapMpp } from "../mpp/mppx.js";

// biome-ignore lint/suspicious/noExplicitAny: Credential is generic over payload
export type VerifiedCredential = ReturnType<typeof Credential.deserialize<any>>;

/**
 * `source` on a proof credential is a `did:pkh` with the format
 * `did:pkh:eip155:<chainId>:<0x-address>`. This regex extracts the address.
 */
const PROOF_SOURCE_RE = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/;

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
	credential: VerifiedCredential,
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
 * Build a 402 `tempo.session` challenge — the paid path. Call this from
 * paid routes when the request arrives without a valid credential. The
 * client opens a channel (the voucher covers `amountUsdcMicro`) and retries.
 *
 * `scope` is HMAC-bound into the challenge id, so a credential signed for
 * one scope cannot be replayed against another route that requires a
 * different scope.
 */
export const buildSessionChallenge = async (
	mppx: MppxInstance,
	opts: {
		amountUsdcMicro: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
): Promise<ChallengeResponse | ChallengeErrorResponse> => {
	try {
		const challenge = await mppx.challenge.tempo.session({
			amount: opts.amountUsdcMicro.toString(),
			scope: opts.scope,
			...(opts.meta ? { meta: opts.meta } : {}),
		});
		return {
			status: 402,
			headers: { "www-authenticate": Challenge.serialize(challenge) },
			body: { challenge, detail: opts.detail },
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
 * Build a 402 `tempo.charge` challenge with `amount="0"` — the "proof
 * credential" flow. Client signs `Proof(challengeId)` to prove they hold a
 * wallet, without moving funds or opening a channel. Used by read/delete
 * routes that need wallet-authz without payment.
 */
export const buildProofChallenge = async (
	mppx: MppxInstance,
	opts: { scope: string; detail: string; meta?: Record<string, string> },
): Promise<ChallengeResponse | ChallengeErrorResponse> => {
	try {
		const challenge = await mppx.challenge.tempo.charge({
			amount: "0",
			scope: opts.scope,
			...(opts.meta ? { meta: opts.meta } : {}),
		});
		return {
			status: 402,
			headers: { "www-authenticate": Challenge.serialize(challenge) },
			body: { challenge, detail: opts.detail },
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

export { Credential, Challenge };
