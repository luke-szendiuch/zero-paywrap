import {
	type RawCredential,
	type VerifiedCredential,
	payerFromCredential,
} from "@zerorun/paywrap/auth";
import { type PaywrapMpp, verifyWithScope } from "@zerorun/paywrap/mpp";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { formatUnits } from "viem";
import type { Hex } from "viem";
import {
	extractCredential,
	sendChargeChallenge,
	sendProofChallenge,
	sendSessionChallenge,
} from "./index.js";

/**
 * Per-request fields populated by the `mppGated` preHandler after a
 * credential has been verified + scope-checked. Both are `undefined` on
 * requests that didn't pass through a gated route, so callers must still
 * be defensive if they share a handler body across gated and ungated
 * routes.
 *
 * The branded `VerifiedCredential` is only produced by `verifyWithScope`
 * — anyone reading `req.verifiedCredential` can trust the scope check
 * already ran.
 */
declare module "fastify" {
	interface FastifyRequest {
		payer?: Hex;
		verifiedCredential?: VerifiedCredential;
	}
	interface FastifyInstance {
		mppGated: (opts: MppGatedOptions) => MppGatedPreHandler;
	}
}

/** USDC on Tempo has 6 decimals — hard-coded to avoid a kit import just for this. */
const USDC_DECIMALS = 6;

/**
 * Intent controls which 402 challenge variant we issue when a request
 * arrives without a valid credential.
 *
 *   - `session`: paid channel-based flow (voucher ledger, extend semantics).
 *     Requires `amount`.
 *   - `charge` : paid single-shot flow (atomic settle, no channel).
 *     Requires `amount`.
 *   - `proof`  : zero-amount wallet-auth. No `amount` required.
 */
export type MppIntent = "session" | "charge" | "proof";

export type MppGatedOptions = {
	/** MANDATORY. HMAC-bound into the challenge id so credentials don't replay cross-route. */
	scope: string;
	/** Micro-USDC (6 decimals). Required for session/charge; omit for proof. */
	amount?: bigint;
	/** Intent. Default: "proof" when amount omitted, "session" when amount set. */
	intent?: MppIntent;
	/** Optional metadata surfaced on the 402 body (e.g. SKU + pricingVersion). */
	meta?: Record<string, string>;
	/** Optional human-readable reason included on the 402 body. Default: a stable per-intent string. */
	detail?: string;
	/** Session-only. Defaults to `amount` when omitted. */
	suggestedDeposit?: bigint;
	/** Session-only. Defaults to "request" at the mppx layer. */
	unitType?: string;
};

// Fastify's preHandler callback can return `void | Promise<void>` or a
// value (the reply). We reply directly for the 402 path so the body isn't
// re-processed downstream — fastify stops handler execution once
// `reply.send()` has been called.
export type MppGatedPreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

// `AppLike` mirrors the shape createFastifyApp's consumers decorate. The
// factory reads from `app.ctx.mppx` (required) and `app.ctx.mppxChannelStore`
// (required for session vouchers + any flow that needs payer resolution).
// Everything else on ctx is opaque.
type AppLike = {
	ctx: {
		mppx: PaywrapMpp["mppx"];
		mppxChannelStore: PaywrapMpp["channelStore"];
	};
};

const resolveIntent = (opts: MppGatedOptions): MppIntent => {
	if (opts.intent) return opts.intent;
	return opts.amount === undefined ? "proof" : "session";
};

const sendChallengeForIntent = async (
	app: AppLike,
	reply: FastifyReply,
	intent: MppIntent,
	opts: MppGatedOptions,
	detail: string,
) => {
	if (intent === "proof") {
		return sendProofChallenge(app, reply, opts.scope, detail, opts.meta);
	}
	if (opts.amount === undefined) {
		// Defensive — registerGated() rejects this at registration time, so
		// it should be unreachable. Kept to make the type-narrowing obvious.
		throw new Error(`paywrap/mppGated: intent="${intent}" requires an amount`);
	}
	const humanAmount = formatUnits(opts.amount, USDC_DECIMALS);
	if (intent === "charge") {
		return sendChargeChallenge(app, reply, {
			amount: humanAmount,
			scope: opts.scope,
			detail,
			...(opts.meta ? { meta: opts.meta } : {}),
		});
	}
	// session
	const humanDeposit =
		opts.suggestedDeposit !== undefined
			? formatUnits(opts.suggestedDeposit, USDC_DECIMALS)
			: humanAmount;
	return sendSessionChallenge(app, reply, {
		amount: humanAmount,
		suggestedDeposit: humanDeposit,
		scope: opts.scope,
		detail,
		...(opts.unitType !== undefined ? { unitType: opts.unitType } : {}),
		...(opts.meta ? { meta: opts.meta } : {}),
	});
};

/**
 * Build the `app.mppGated(...)` factory and attach it to the fastify
 * instance. Returns a preHandler that:
 *
 *   1. Pulls the `Authorization` / `Payment` header off the request.
 *   2. Parses it as an mppx credential.
 *   3. Runs `verifyWithScope(mppx, credential, opts.scope)` — HMAC + scope.
 *   4. Resolves the payer via `payerFromCredential` (channel store lookup
 *      for session vouchers, did:pkh parse for proof credentials).
 *   5. Populates `req.payer` + `req.verifiedCredential` for the route
 *      handler.
 *
 * On any failure (missing header, parse error, verify failure, payer
 * resolution failure) we short-circuit with a 402 challenge matching the
 * configured intent. Fastify's convention: calling `reply.send()` from a
 * preHandler marks the reply as sent and the handler body is NOT invoked.
 */
export const registerMppGated = (app: FastifyInstance) => {
	const factory = (opts: MppGatedOptions): MppGatedPreHandler => {
		if (!opts.scope || typeof opts.scope !== "string") {
			throw new Error("paywrap/mppGated: `scope` is required and must be a non-empty string");
		}
		const intent = resolveIntent(opts);
		if ((intent === "session" || intent === "charge") && opts.amount === undefined) {
			throw new Error(
				`paywrap/mppGated: intent="${intent}" requires \`amount\` (micro-USDC bigint)`,
			);
		}
		const defaultDetail = intent === "proof" ? "auth_required" : "payment_required";

		return async (req, reply) => {
			// `app.ctx` is decorated by createFastifyApp; consumers augment its
			// typed shape. We re-narrow to the minimum we need here.
			const gatedApp = { ctx: (req.server as unknown as AppLike).ctx };
			const header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
			const credential = extractCredential(header) as RawCredential | null;
			if (!credential) {
				await sendChallengeForIntent(gatedApp, reply, intent, opts, opts.detail ?? defaultDetail);
				return;
			}

			let verified: VerifiedCredential;
			try {
				verified = await verifyWithScope(gatedApp.ctx.mppx, credential, opts.scope);
			} catch (err) {
				const detail = err instanceof Error ? err.message : "verify_failed";
				await sendChallengeForIntent(gatedApp, reply, intent, opts, detail);
				return;
			}

			const payer = await payerFromCredential(gatedApp.ctx.mppxChannelStore, verified);
			if (!payer) {
				// A verified credential with no resolvable payer means the
				// channel row disappeared between mppx's verify and our store
				// read. Re-challenge rather than 500 — the client can retry.
				await sendChallengeForIntent(
					gatedApp,
					reply,
					intent,
					opts,
					"channel_state_missing_after_verify",
				);
				return;
			}

			req.payer = payer;
			req.verifiedCredential = verified;
		};
	};

	app.decorate("mppGated", factory);
	return app;
};
