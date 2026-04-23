import {
	type RawCredential,
	type VerifiedCredential,
	claimedPayerFromRawCredential,
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
} from "./challenges.js";

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

/**
 * Result of a `preCheck` callback.
 *
 *   - `{ok: true}` — proceed to `verifyWithScope` as normal.
 *   - `{ok: false, status, body}` — short-circuit with this response.
 *     No verify, no charge, no handler invocation. Use this to detect
 *     preconditions that would make the paid work impossible (e.g.
 *     name-collision on a "create" endpoint).
 *   - `{ok: "already_done", payer, verifiedCredential}` — the preCheck
 *     determined this is an idempotent retry of an operation that was
 *     already paid for. Skip verify (mppx would reject as
 *     already-settled), populate `req.payer` + `req.verifiedCredential`
 *     from the returned values, and invoke the route handler. Only use
 *     this branch when you can safely synthesize a `VerifiedCredential`
 *     for the operation; otherwise return `{ok: false, status: 202, ...}`.
 */
export type MppGatedPreCheckResult =
	| { ok: true }
	| { ok: false; status: number; body: unknown }
	| { ok: "already_done"; payer: Hex; verifiedCredential: VerifiedCredential };

/**
 * Callback invoked AFTER credential parse + `claimedPayer` extraction,
 * BEFORE `verifyWithScope`. See `MppGatedPreCheckResult` for the three
 * outcomes.
 *
 * `claimedPayer` is NOT security-authoritative — it's a hint pulled from
 * the raw credential (channel store lookup for session vouchers, did:pkh
 * parse for charge/proof credentials). Use it to structure pre-verify
 * work (e.g. DB reads keyed on wallet) that the subsequent verify call
 * will validate. Never commit (settle, charge, grant) based on this
 * value alone.
 */
export type MppGatedPreCheck = (context: {
	rawCredential: RawCredential;
	claimedPayer: Hex | null;
	request: FastifyRequest;
	reply: FastifyReply;
}) => Promise<MppGatedPreCheckResult>;

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
	/**
	 * Optional pre-verify hook. Runs after credential parse, before
	 * `verifyWithScope`. Critical for paid routes whose preconditions
	 * must be checked BEFORE a charge settles — e.g. name-collision on
	 * a "create" endpoint where a 409 must not cost the buyer.
	 */
	preCheck?: MppGatedPreCheck;
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

			// Run the caller's preCheck (if any) BEFORE verify so
			// preconditions that would reject the request don't cost the
			// buyer a settled charge. `claimedPayer` is a best-effort hint
			// — NOT authoritative — suitable for pre-verify DB lookups.
			if (opts.preCheck) {
				let claimedPayer: Hex | null = null;
				try {
					claimedPayer = await claimedPayerFromRawCredential(
						gatedApp.ctx.mppxChannelStore,
						credential,
					);
				} catch {
					// Claimed-payer extraction is best-effort; fall through
					// with null and let preCheck decide.
					claimedPayer = null;
				}

				let result: MppGatedPreCheckResult;
				try {
					result = await opts.preCheck({
						rawCredential: credential,
						claimedPayer,
						request: req,
						reply,
					});
				} catch (err) {
					req.log.error(
						{ err: err instanceof Error ? err.message : String(err) },
						"paywrap/mppGated: preCheck threw — responding 500",
					);
					await reply.status(500).send({ error: "precheck_failed" });
					return;
				}

				if (result.ok === false) {
					await reply.status(result.status).send(result.body);
					return;
				}
				if (result.ok === "already_done") {
					// Caller determined this is an idempotent retry. Skip
					// verify (mppx would reject already-settled) and hand
					// the handler the payer + verifiedCredential the
					// preCheck vouches for.
					req.payer = result.payer;
					req.verifiedCredential = result.verifiedCredential;
					return;
				}
				// result.ok === true — fall through to verify.
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
