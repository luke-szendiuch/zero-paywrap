import {
	type RawCredential,
	type VerifiedCredential,
	claimedPayerFromRawCredential,
	extractCredential,
	payerFromCredential,
} from "@zerorun/paywrap/auth";
import { type PaywrapMpp, verifyWithScope } from "@zerorun/paywrap/mpp";
import type { Context, MiddlewareHandler } from "hono";
import { formatUnits } from "viem";
import type { Hex } from "viem";
import { sendChargeChallenge, sendProofChallenge, sendSessionChallenge } from "./challenges.js";

/**
 * Consumers wire `mppGated` onto typed routes like so:
 *
 *   const app = new Hono<{ Variables: PaywrapVariables }>();
 *   app.post('/paid', mppGated({ scope: 'x:1', amount: 50_000n }), (c) => {
 *     const payer = c.var.payer;            // typed Hex
 *     const cred  = c.var.verifiedCredential;
 *     ...
 *   });
 *
 * The branded `VerifiedCredential` is only produced by `verifyWithScope`
 * — anyone reading `c.var.verifiedCredential` can trust the scope check
 * already ran.
 */
export type PaywrapVariables = {
	payer: Hex;
	verifiedCredential: VerifiedCredential;
};

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
 * Result of a `preCheck` callback. See the fastify adapter for the full
 * semantics — identical here; the only difference is the hook receives a
 * Hono `Context` instead of a fastify `request`/`reply` pair.
 */
export type MppGatedPreCheckResult =
	| { ok: true }
	| { ok: false; status: number; body: unknown }
	| { ok: "already_done"; payer: Hex; verifiedCredential: VerifiedCredential };

/**
 * Callback invoked AFTER credential parse + `claimedPayer` extraction,
 * BEFORE `verifyWithScope`.
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
	// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
	c: Context<any, any, any>;
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

// `AppLike` mirrors the ctx `createHonoApp`'s consumers decorate. The
// middleware reads `ctx.mppx` (required) + `ctx.mppxChannelStore` (required
// for session vouchers + any flow that needs payer resolution).
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

// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
type AnyContext = Context<any, any, any>;

const sendChallengeForIntent = (
	app: AppLike,
	c: AnyContext,
	intent: MppIntent,
	opts: MppGatedOptions,
	detail: string,
): Promise<Response> => {
	if (intent === "proof") {
		return sendProofChallenge(app, c, opts.scope, detail, opts.meta);
	}
	if (opts.amount === undefined) {
		// Defensive — `mppGated` rejects this at registration time, so this
		// should be unreachable. Kept to make the type-narrowing obvious.
		throw new Error(`paywrap/mppGated: intent="${intent}" requires an amount`);
	}
	const humanAmount = formatUnits(opts.amount, USDC_DECIMALS);
	if (intent === "charge") {
		return sendChargeChallenge(app, c, {
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
	return sendSessionChallenge(app, c, {
		amount: humanAmount,
		suggestedDeposit: humanDeposit,
		scope: opts.scope,
		detail,
		...(opts.unitType !== undefined ? { unitType: opts.unitType } : {}),
		...(opts.meta ? { meta: opts.meta } : {}),
	});
};

/**
 * Hono middleware factory. Use directly on a route or group:
 *
 *   app.post('/paid', mppGated({ scope: 'paid:1', amount: 50_000n }), handler)
 *
 * The middleware:
 *
 *   1. Pulls the `Authorization` / `Payment` header off the request.
 *   2. Parses it as an mppx credential.
 *   3. Runs optional `preCheck` (pre-verify short-circuit + idempotency).
 *   4. Runs `verifyWithScope(mppx, credential, opts.scope)` — HMAC + scope.
 *   5. Resolves the payer via `payerFromCredential`.
 *   6. Sets `c.var.payer` + `c.var.verifiedCredential`, invokes `next()`.
 *
 * On any failure (missing header, parse error, verify failure, payer
 * resolution failure) we short-circuit with a 402 challenge matching the
 * configured intent — Hono's convention: returning a response from a
 * middleware without calling `next()` stops the chain.
 *
 * Consumer's ctx must carry `mppx` + `mppxChannelStore`; we read them from
 * `c.get('paywrapApp')` (set by `createHonoApp`) OR `c.env.paywrapApp` as
 * fallback. If neither is present, we throw — a clear setup error.
 */
export const mppGated = (
	opts: MppGatedOptions,
): MiddlewareHandler<{ Variables: PaywrapVariables }> => {
	if (!opts.scope || typeof opts.scope !== "string") {
		throw new Error("paywrap/mppGated: `scope` is required and must be a non-empty string");
	}
	const intent = resolveIntent(opts);
	if ((intent === "session" || intent === "charge") && opts.amount === undefined) {
		throw new Error(`paywrap/mppGated: intent="${intent}" requires \`amount\` (micro-USDC bigint)`);
	}
	const defaultDetail = intent === "proof" ? "auth_required" : "payment_required";

	return async (c, next) => {
		const gatedApp = resolveApp(c);
		const header = c.req.header("authorization") ?? c.req.header("payment") ?? undefined;
		const credential = extractCredential(header);
		if (!credential) {
			return sendChallengeForIntent(gatedApp, c, intent, opts, opts.detail ?? defaultDetail);
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
					c,
				});
			} catch {
				// biome-ignore lint/suspicious/noExplicitAny: see challenges.ts
				return c.json({ error: "precheck_failed" } as any, 500 as any);
			}

			if (result.ok === false) {
				// biome-ignore lint/suspicious/noExplicitAny: see challenges.ts
				return c.json(result.body as any, result.status as any);
			}
			if (result.ok === "already_done") {
				// Set typed vars and invoke handler. `c.var.<key>` type-narrows
				// via the `Variables` binding from the middleware return type.
				c.set("payer", result.payer);
				c.set("verifiedCredential", result.verifiedCredential);
				await next();
				return;
			}
			// result.ok === true — fall through to verify.
		}

		let verified: VerifiedCredential;
		try {
			verified = await verifyWithScope(gatedApp.ctx.mppx, credential, opts.scope);
		} catch (err) {
			const detail = err instanceof Error ? err.message : "verify_failed";
			return sendChallengeForIntent(gatedApp, c, intent, opts, detail);
		}

		const payer = await payerFromCredential(gatedApp.ctx.mppxChannelStore, verified);
		if (!payer) {
			return sendChallengeForIntent(
				gatedApp,
				c,
				intent,
				opts,
				"channel_state_missing_after_verify",
			);
		}

		c.set("payer", payer);
		c.set("verifiedCredential", verified);
		await next();
	};
};

/**
 * Locate the paywrap AppLike. `createHonoApp` registers a pre-middleware
 * that sets `c.set('paywrapApp', { ctx })` on every request; consumers
 * using that helper get wiring for free. Consumers who construct their
 * own Hono instance can set the same variable manually.
 */
const resolveApp = (c: AnyContext): AppLike => {
	const fromVar = c.get("paywrapApp") as AppLike | undefined;
	if (fromVar) return fromVar;
	throw new Error(
		"paywrap/mppGated: expected `paywrapApp` on c.var — did you build the Hono instance with createHonoApp(ctx), or set c.set('paywrapApp', { ctx }) in a prior middleware?",
	);
};
