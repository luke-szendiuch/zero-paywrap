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

// Populated by the `mppGated` preHandler after scope-check. Both undefined on
// requests that didn't pass through a gated route.
declare module "fastify" {
	interface FastifyRequest {
		payer?: Hex;
		verifiedCredential?: VerifiedCredential;
	}
	interface FastifyInstance {
		mppGated: (opts: MppGatedOptions) => MppGatedPreHandler;
	}
}

/** USDC on Tempo has 6 decimals — hard-coded to avoid a kit import. */
const USDC_DECIMALS = 6;

/**
 * Intent controls which 402 variant we issue when no valid credential is
 * present. `session` and `charge` require `amount`; `proof` does not.
 */
export type MppIntent = "session" | "charge" | "proof";

/**
 * Result of a `preCheck` callback.
 *   - `{ok: true}` → proceed to verify.
 *   - `{ok: false, status, body}` → short-circuit without verifying; use for
 *     preconditions that would reject the request (e.g. name collision) so
 *     the buyer isn't charged for work that can't happen.
 *   - `{ok: "already_done", ...}` → idempotent retry of an already-paid
 *     operation. Skip verify (mppx rejects already-settled), use the
 *     supplied payer + verifiedCredential. Only use when you can safely
 *     synthesize a verified credential for the op.
 */
export type MppGatedPreCheckResult =
	| { ok: true }
	| { ok: false; status: number; body: unknown }
	| { ok: "already_done"; payer: Hex; verifiedCredential: VerifiedCredential };

/**
 * `preCheck` runs AFTER credential parse + `claimedPayer` extraction, BEFORE
 * verify. `claimedPayer` is NOT authoritative — a hint from the raw
 * credential (channel store lookup for session vouchers, did:pkh parse for
 * charge/proof). Use it to structure pre-verify DB reads that the verify
 * call will validate. Never commit based on this value alone.
 */
export type MppGatedPreCheck = (context: {
	rawCredential: RawCredential;
	claimedPayer: Hex | null;
	request: FastifyRequest;
	reply: FastifyReply;
}) => Promise<MppGatedPreCheckResult>;

export type MppGatedOptions = {
	/** HMAC-bound into the challenge id so credentials don't replay cross-route. */
	scope: string;
	/** Micro-USDC (6 decimals). Required for session/charge; omit for proof. */
	amount?: bigint;
	/** Default: "proof" when amount omitted, "session" when amount set. */
	intent?: MppIntent;
	/** Surfaced on the 402 body (e.g. SKU + pricingVersion). */
	meta?: Record<string, string>;
	/** Human-readable reason on the 402 body. Default: a per-intent string. */
	detail?: string;
	/** Session-only. Defaults to `amount`. */
	suggestedDeposit?: bigint;
	/** Session-only. Defaults to "request" at the mppx layer. */
	unitType?: string;
	preCheck?: MppGatedPreCheck;
};

// Fastify's preHandler returns void; reply.send() stops handler execution.
export type MppGatedPreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

// Minimum ctx shape `mppGated` reads.
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
	// Unreachable: factory rejects this at registration. Kept for type narrowing.
	if (opts.amount === undefined) {
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
 * Attach `app.mppGated(...)` preHandler factory. The preHandler: pulls
 * header → parses credential → optional preCheck → `verifyWithScope` →
 * resolves payer via channel store / did:pkh → populates
 * `req.payer` + `req.verifiedCredential`. Any failure short-circuits with a
 * 402 matching the configured intent.
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
			const gatedApp = { ctx: (req.server as unknown as AppLike).ctx };
			const header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
			const credential = extractCredential(header) as RawCredential | null;
			if (!credential) {
				await sendChallengeForIntent(gatedApp, reply, intent, opts, opts.detail ?? defaultDetail);
				return;
			}

			if (opts.preCheck) {
				let claimedPayer: Hex | null = null;
				try {
					claimedPayer = await claimedPayerFromRawCredential(
						gatedApp.ctx.mppxChannelStore,
						credential,
					);
				} catch {
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
					req.payer = result.payer;
					req.verifiedCredential = result.verifiedCredential;
					return;
				}
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
				// Verified credential with no resolvable payer — channel row
				// disappeared between verify and store read. Re-challenge
				// rather than 500; client can retry.
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
