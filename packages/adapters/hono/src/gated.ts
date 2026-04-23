import {
	type RawCredential,
	type VerifiedCredential,
	claimedPayerFromRawCredential,
	extractCredential,
	payerFromCredential,
} from "@zeroclickai/paywrap/auth";
import { type PaywrapMpp, verifyWithScope } from "@zeroclickai/paywrap/mpp";
import type { Context, MiddlewareHandler } from "hono";
import { formatUnits } from "viem";
import type { Hex } from "viem";
import { sendChargeChallenge, sendProofChallenge, sendSessionChallenge } from "./challenges.js";

/**
 * Typed variables set by `mppGated` after verify:
 *
 *   const app = new Hono<{ Variables: PaywrapVariables }>();
 *   app.post('/paid', mppGated({ scope: 'x:1', amount: 50_000n }), (c) => {
 *     const payer = c.var.payer;            // typed Hex
 *     const cred  = c.var.verifiedCredential;
 *   });
 */
export type PaywrapVariables = {
	payer: Hex;
	verifiedCredential: VerifiedCredential;
};

/** USDC on Tempo has 6 decimals — hard-coded to avoid a kit import. */
const USDC_DECIMALS = 6;

export type MppIntent = "session" | "charge" | "proof";

/** See fastify adapter — identical semantics. */
export type MppGatedPreCheckResult =
	| { ok: true }
	| { ok: false; status: number; body: unknown }
	| { ok: "already_done"; payer: Hex; verifiedCredential: VerifiedCredential };

/**
 * Runs AFTER credential parse + claimedPayer, BEFORE verify. `claimedPayer`
 * is NOT authoritative — use only to structure pre-verify DB reads.
 */
export type MppGatedPreCheck = (context: {
	rawCredential: RawCredential;
	claimedPayer: Hex | null;
	// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
	c: Context<any, any, any>;
}) => Promise<MppGatedPreCheckResult>;

export type MppGatedOptions = {
	scope: string;
	amount?: bigint;
	intent?: MppIntent;
	meta?: Record<string, string>;
	detail?: string;
	suggestedDeposit?: bigint;
	unitType?: string;
	preCheck?: MppGatedPreCheck;
};

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
	// Unreachable: `mppGated` rejects this at registration. Keeps type narrowing.
	if (opts.amount === undefined) {
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
 * Hono middleware. Pulls `Authorization`/`Payment` → parses credential →
 * optional `preCheck` → `verifyWithScope` → resolves payer → sets
 * `c.var.payer` + `c.var.verifiedCredential`. Any failure short-circuits
 * with a 402 matching `intent`.
 *
 * Consumer's ctx must carry `mppx` + `mppxChannelStore`, reached via
 * `c.get('paywrapApp')` (set by `createHonoApp` or a prior middleware).
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
				c.set("payer", result.payer);
				c.set("verifiedCredential", result.verifiedCredential);
				await next();
				return;
			}
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

const resolveApp = (c: AnyContext): AppLike => {
	const fromVar = c.get("paywrapApp") as AppLike | undefined;
	if (fromVar) return fromVar;
	throw new Error(
		"paywrap/mppGated: expected `paywrapApp` on c.var — did you build the Hono instance with createHonoApp(ctx), or set c.set('paywrapApp', { ctx }) in a prior middleware?",
	);
};
