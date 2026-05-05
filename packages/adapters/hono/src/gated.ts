import {
	type RawCredential,
	type VerifiedCredential,
	claimedPayerFromRawCredential,
	extractCredential,
	fingerprintCredential,
	payerFromCredential,
} from "@zeroclickai/paywrap/auth";
import { type LoggerCallback, safeLog, shortFingerprint } from "@zeroclickai/paywrap/logger";
import { type PaywrapMpp, rollbackSessionVoucher, verifyWithScope } from "@zeroclickai/paywrap/mpp";
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
	/**
	 * Session-intent only. When `true`, captures the prior `highestVoucher`
	 * before verify and rolls it back if the handler throws — the failed
	 * call's amount stays in escrow and refunds to the buyer naturally on
	 * the next `closeSessionOnChain`.
	 *
	 * The error is re-thrown after rollback so Hono's error handler still
	 * sees it. Has no effect for charge or proof intent (charge settles
	 * atomically; proof moves no money).
	 *
	 * Default: `false`. Failed calls bill the buyer until the seller
	 * decides otherwise.
	 */
	refundOnFailure?: boolean;
};

type AppLike = {
	ctx: {
		mppx: PaywrapMpp["mppx"];
		mppxChannelStore: PaywrapMpp["channelStore"];
		paywrapLogger?: LoggerCallback;
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
		const logger = gatedApp.ctx.paywrapLogger;
		const route = `${c.req.method} ${c.req.path}`;
		const startedAt = Date.now();
		const header = c.req.header("authorization") ?? c.req.header("payment") ?? undefined;
		const credential = extractCredential(header);
		if (!credential) {
			await safeLog(logger, {
				v: 1,
				kind: "payment_required",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				route,
				scope: opts.scope,
				intent,
				...(opts.amount !== undefined ? { amountUsdcMicro: opts.amount.toString() } : {}),
				...(opts.meta ? { meta: opts.meta } : {}),
			});
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
			} catch (err) {
				await safeLog(logger, {
					v: 1,
					kind: "payment_failed",
					timestamp: new Date().toISOString(),
					protocol: "mpp",
					stage: "precheck",
					reason: err instanceof Error ? err.message : "precheck_failed",
					scope: opts.scope,
					route,
				});
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

		// Capture pre-verify voucher state for refund-on-failure rollback.
		// Only meaningful for session intent — charge settles atomically (no
		// rollback target), proof moves no money. We read by `channelId` from
		// the raw credential before verify because verify is what advances
		// `state.highestVoucher`; reading after would capture the post-advance
		// value and rollback would be a no-op.
		const refundOnFailure = opts.refundOnFailure === true && intent === "session";
		let priorVoucher: NonNullable<
			Awaited<ReturnType<typeof gatedApp.ctx.mppxChannelStore.getChannel>>
		>["highestVoucher"] = null;
		let rollbackChannelId: Hex | null = null;
		if (refundOnFailure) {
			const payload = (credential as { payload?: { channelId?: Hex } }).payload;
			const channelId = payload?.channelId;
			if (channelId) {
				try {
					const state = await gatedApp.ctx.mppxChannelStore.getChannel(channelId);
					priorVoucher = state?.highestVoucher ?? null;
					rollbackChannelId = channelId;
				} catch {
					// best-effort — if the read fails, we just won't roll back
					rollbackChannelId = null;
				}
			}
		}

		let verified: VerifiedCredential;
		try {
			verified = await verifyWithScope(gatedApp.ctx.mppx, credential, opts.scope);
		} catch (err) {
			const detail = err instanceof Error ? err.message : "verify_failed";
			await safeLog(logger, {
				v: 1,
				kind: "payment_failed",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				stage: "verify",
				reason: detail,
				scope: opts.scope,
				route,
			});
			return sendChallengeForIntent(gatedApp, c, intent, opts, detail);
		}

		const payer = await payerFromCredential(gatedApp.ctx.mppxChannelStore, verified);
		if (!payer) {
			await safeLog(logger, {
				v: 1,
				kind: "payment_failed",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				stage: "verify",
				reason: "channel_state_missing_after_verify",
				scope: opts.scope,
				route,
			});
			return sendChallengeForIntent(
				gatedApp,
				c,
				intent,
				opts,
				"channel_state_missing_after_verify",
			);
		}

		// Emit settled event for paid intents (charge/session). `proof` is auth-only,
		// no money moves, so we skip the money-log for that intent.
		if (logger && (intent === "charge" || intent === "session") && opts.amount !== undefined) {
			const fp = shortFingerprint(await fingerprintCredential(header ?? ""));
			await safeLog(logger, {
				v: 1,
				kind: "payment_settled",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				payer,
				seller: gatedApp.ctx.mppx?.account?.address ?? ("0x" as Hex),
				amountUsdcMicro: opts.amount.toString(),
				route,
				scope: opts.scope,
				...(opts.meta?.sku ? { sku: opts.meta.sku } : {}),
				latencyMs: Date.now() - startedAt,
				credentialFingerprint: fp,
			});
		}

		c.set("payer", payer);
		c.set("verifiedCredential", verified);

		// Wrap next() so we catch handler errors regardless of whether the
		// app has an `onError` registered. Hono routes thrown errors through
		// `app.errorHandler` and surfaces them on `c.error` rather than
		// propagating through middleware — so we check both: try/catch (for
		// no-onError apps) and `c.error` (for apps with onError).
		let handlerError: unknown = undefined;
		try {
			await next();
		} catch (err) {
			handlerError = err;
		}
		if (handlerError === undefined && c.error !== undefined) {
			handlerError = c.error;
		}

		if (handlerError !== undefined && refundOnFailure && rollbackChannelId) {
			const reason = handlerError instanceof Error ? handlerError.message : "handler_threw";
			try {
				const result = await rollbackSessionVoucher(
					gatedApp.ctx.mppxChannelStore,
					rollbackChannelId,
					priorVoucher,
				);
				await safeLog(logger, {
					v: 1,
					kind: "payment_failed",
					timestamp: new Date().toISOString(),
					protocol: "mpp",
					stage: "post_handler",
					reason: `voucher_rolled_back:${result.status === "rolled-back" ? "ok" : `skipped(${result.reason})`}:${reason}`,
					scope: opts.scope,
					route,
				});
			} catch {
				// Rollback itself failed — surface via the original error path,
				// don't shadow the handler error.
			}
		}
		if (handlerError !== undefined) {
			// Re-throw so apps without onError still get the default 500;
			// apps with onError already absorbed it.
			throw handlerError;
		}
		await safeLog(logger, {
			v: 1,
			kind: "request_completed",
			timestamp: new Date().toISOString(),
			route,
			status: c.res.status,
			latencyMs: Date.now() - startedAt,
			payer,
		});
	};
};

const resolveApp = (c: AnyContext): AppLike => {
	const fromVar = c.get("paywrapApp") as AppLike | undefined;
	if (fromVar) return fromVar;
	throw new Error(
		"paywrap/mppGated: expected `paywrapApp` on c.var — did you build the Hono instance with createHonoApp(ctx), or set c.set('paywrapApp', { ctx }) in a prior middleware?",
	);
};
