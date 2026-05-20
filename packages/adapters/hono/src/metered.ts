import {
	type RawCredential,
	type SessionReceiptPayload,
	type VerifiedCredential,
	encodeSessionReceipt,
	extractCredential,
	fingerprintCredential,
	payerFromCredential,
} from "@zeroclickai/paywrap/auth";
import { type LoggerCallback, safeLog, shortFingerprint } from "@zeroclickai/paywrap/logger";
import { type PaywrapMpp, verifyWithScope } from "@zeroclickai/paywrap/mpp";
import { persistMeteredCloseVoucher } from "@zeroclickai/paywrap/mpp/metered";
import type { Context, MiddlewareHandler } from "hono";
import { formatUnits } from "viem";
import type { Hex } from "viem";
import { sendSessionChallenge } from "./challenges.js";
import type { PaywrapVariables } from "./gated.js";

/**
 * Hono variables `mppMetered` adds on top of the `mppGated` shape. Handlers
 * MUST call `settle(actualAmount)` before returning so the middleware can
 * emit the `Payment-Receipt` header at the resolved cost. If they forget on
 * a successful response, the middleware falls back to `maxAmount` and logs a
 * `fallback: true` event so we can audit the bug. If they forget on a failed
 * response, thrown handler, or aborted request, the middleware settles `0n`
 * by default so validation/upstream failures do not consume the buyer's
 * escrow.
 *
 * Augment Hono's variables to type-narrow:
 *   const app = new Hono<{ Variables: PaywrapMeteredVariables }>()
 *
 * `settle` is idempotent for the last-wins case — if you call it twice the
 * second wins, but you'll usually want to call it exactly once with the
 * value you computed from the upstream response.
 *
 * `settle` is frozen the moment the handler returns. Late calls (from
 * `setImmediate`, an unawaited Promise, etc.) are ignored with a
 * `metered_late_settle_ignored` log event — the receipt has already been
 * emitted by that point and the channel's `spent` already overridden, so a
 * late write cannot reach the wire and silently mutating local state would
 * desync downstream loggers from the receipt.
 */
export type PaywrapMeteredVariables = PaywrapVariables & {
	/**
	 * Record the actual amount this request consumed. Must be called before
	 * the handler returns. Value will be encoded into the `Payment-Receipt`
	 * header and used as `acceptedCumulative` on the buyer's close voucher.
	 *
	 * If `actualAmount > maxAmount`, the value is clamped to `maxAmount`
	 * (the buyer's voucher only authorized up to maxAmount; we cannot bill
	 * beyond what they signed). Clamping is logged with `clamped: true`.
	 *
	 * **Streaming + abort:** for SSE / chunked responses, observe
	 * `c.req.raw.signal` and call `settle(actualBytesServed * pricePerByte)`
	 * from your abort handler before the handler returns. If the request
	 * aborts and the handler never calls `settle`, the middleware defaults
	 * to `0n` (not `maxAmount`) — the buyer disconnected, they received
	 * nothing of value.
	 */
	settle: (actualAmount: bigint) => void;
	/**
	 * Final amount written to `Payment-Receipt` and `channel.spent`, clamped
	 * to `[0, maxAmount]`. Set by `mppMetered` after the handler returns —
	 * **undefined while the handler is executing**. Outer middlewares (usage
	 * loggers, billing rollups) can read this to record the canonical settled
	 * amount instead of re-implementing the clamp.
	 */
	settledAmount?: bigint;
};

/** Convenience alias for handler typing. */
export type PaywrapMeteredContext = Context<{ Variables: PaywrapMeteredVariables }>;

/** USDC on Tempo has 6 decimals — hard-coded to avoid a kit import. */
const USDC_DECIMALS = 6;

export type MppMeteredOptions = {
	scope: string;
	/**
	 * Upper bound. The buyer's voucher must cover at least this amount —
	 * routes that handle wildly variable inputs (long audio, big PDFs)
	 * should pick a generous max and rely on the actual settle to refund
	 * unused capacity at session close.
	 */
	maxAmount: bigint;
	meta?: Record<string, string>;
	detail?: string;
	unitType?: string;
};

type AppLike = {
	ctx: {
		mppx: PaywrapMpp["mppx"];
		mppxChannelStore: PaywrapMpp["channelStore"];
		paywrapLogger?: LoggerCallback;
	};
};

// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
type AnyContext = Context<any, any, any>;

const resolveApp = (c: AnyContext): AppLike => {
	const fromVar = c.get("paywrapApp") as AppLike | undefined;
	if (fromVar) return fromVar;
	throw new Error(
		"paywrap/mppMetered: expected `paywrapApp` on c.var — did you build the Hono instance with createHonoApp(ctx)?",
	);
};

const readCredentialIds = (
	credential: RawCredential,
): { channelId?: string; challengeId?: string } => {
	// Both fields are documented in the kit's signing/auth modules. Defensive
	// reads keep this safe even if a future credential variant omits either.
	const payload = credential.payload as { channelId?: string };
	const challenge = credential.challenge as { id?: string } | undefined;
	return {
		...(payload?.channelId ? { channelId: payload.channelId } : {}),
		...(challenge?.id ? { challengeId: challenge.id } : {}),
	};
};

const readCredentialAction = (credential: RawCredential): string | undefined => {
	const payload = credential.payload as { action?: string } | undefined;
	return payload?.action;
};

/**
 * Hono middleware for **metered** session-intent paid routes.
 *
 * Flow per request:
 *
 *   1. Extract credential. If missing → 402 session challenge with
 *      `amount = maxAmount` (buyer's CLI deposits maxAmount into escrow).
 *   2. `verifyWithScope(credential, scope)` — same path as `mppGated`.
 *   3. Set `c.var.payer`, `c.var.verifiedCredential`, `c.var.settle`.
 *   4. Run the handler. Handler computes the actual cost (from upstream
 *      response metadata, input size, etc.) and calls `c.var.settle(actual)`.
 *   5. Encode `Payment-Receipt: base64url({channelId, challengeId,
 *      acceptedCumulative: actual, spent: actual})` onto the response.
 *   6. Emit `payment_metered_settled` log event.
 *
 * The CLI side (`zero fetch`) decodes Payment-Receipt and signs a close
 * voucher at `acceptedCumulative`. Server submits that close voucher
 * on-chain — the buyer pays only the actual amount, the unused
 * `maxAmount - actual` returns to the buyer as the channel closes.
 *
 * Trust assumption (same as fixed-price session): the seller HOLDS the
 * per-request voucher (cumulative = maxAmount) as insurance. If buyer
 * refuses to sign close, seller can still submit the per-request voucher
 * at maxAmount. Honest seller submits the close.
 */
export const mppMetered = (
	opts: MppMeteredOptions,
): MiddlewareHandler<{ Variables: PaywrapMeteredVariables }> => {
	if (!opts.scope || typeof opts.scope !== "string") {
		throw new Error("paywrap/mppMetered: `scope` is required and must be a non-empty string");
	}
	if (typeof opts.maxAmount !== "bigint" || opts.maxAmount <= 0n) {
		throw new Error("paywrap/mppMetered: `maxAmount` must be a positive bigint (micro-USDC)");
	}
	const defaultDetail = opts.detail ?? "metered_payment_required";

	return async (c, next) => {
		const app = resolveApp(c);
		const logger = app.ctx.paywrapLogger;
		const route = `${c.req.method} ${c.req.path}`;
		const startedAt = Date.now();
		const header = c.req.header("authorization") ?? c.req.header("payment") ?? undefined;
		const credential = extractCredential(header);
		const humanMax = formatUnits(opts.maxAmount, USDC_DECIMALS);
		const challengeOpts = {
			amount: humanMax,
			suggestedDeposit: humanMax,
			scope: opts.scope,
			detail: defaultDetail,
			...(opts.unitType !== undefined ? { unitType: opts.unitType } : {}),
			...(opts.meta ? { meta: opts.meta } : {}),
		};

		if (!credential) {
			await safeLog(logger, {
				v: 1,
				kind: "payment_required",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				route,
				scope: opts.scope,
				intent: "session",
				amountUsdcMicro: opts.maxAmount.toString(),
				...(opts.meta ? { meta: opts.meta } : {}),
			});
			return sendSessionChallenge(app, c, challengeOpts);
		}

		// CLOSE-VOUCHER PATH ────────────────────────────────────────────────
		// CLI replays the original POST URL with action="close" + cumulative
		// = acceptedCumulative from the receipt. Two-step settle for resilience
		// against on-chain RPC failures:
		//
		//   1. PERSIST the close voucher to channel state (`paywrapCloseVoucher`)
		//      via `persistMeteredCloseVoucher` BEFORE attempting on-chain
		//      submission. Survives Worker restarts / RPC blips so a reaper
		//      calling `closeSessionOnChain` can retry.
		//   2. VERIFY via mppx (which also submits closeOnChain). On success
		//      the channel is finalized in one round-trip; the persisted
		//      voucher becomes redundant (already-finalized check skips it).
		//      On RPC failure the persisted voucher is the recovery path.
		//
		// mppx's handleClose validates voucher.cumulativeAmount >= channel.spent.
		// The post-handler block in this middleware overrides channel.spent to
		// the metered actual after settle(); without that, mppx's auto-charge
		// of request.amount=maxAmount would block sub-max closes.
		const action = readCredentialAction(credential);
		if (action === "close") {
			const closePayload = credential.payload as {
				channelId?: Hex;
				cumulativeAmount?: string;
				signature?: Hex;
			};
			if (closePayload.channelId && closePayload.cumulativeAmount && closePayload.signature) {
				try {
					await persistMeteredCloseVoucher(app.ctx.mppx, closePayload.channelId, {
						channelId: closePayload.channelId,
						cumulativeAmount: BigInt(closePayload.cumulativeAmount),
						signature: closePayload.signature,
					});
				} catch (err) {
					// Persistence failure is non-fatal — verify path still
					// runs synchronously below. Logged so it shows up in audit.
					await safeLog(logger, {
						v: 1,
						kind: "payment_failed",
						timestamp: new Date().toISOString(),
						protocol: "mpp",
						stage: "settle",
						reason:
							err instanceof Error
								? `metered_close_persist_failed:${err.message}`
								: "metered_close_persist_failed",
						scope: opts.scope,
						route,
					});
				}
			}
			try {
				await verifyWithScope(app.ctx.mppx, credential, opts.scope);
			} catch (err) {
				const detail = err instanceof Error ? err.message : "close_verify_failed";
				await safeLog(logger, {
					v: 1,
					kind: "payment_failed",
					timestamp: new Date().toISOString(),
					protocol: "mpp",
					stage: "settle",
					reason: detail,
					scope: opts.scope,
					route,
				});
				// Surface the failure to the buyer so the CLI doesn't think
				// the close succeeded. 422 (unprocessable) — credential
				// shape is fine, but the channel state rejects it.
				// biome-ignore lint/suspicious/noExplicitAny: hono StatusCode union
				return c.json({ error: "close_failed", detail } as any, 422 as any);
			}
			const ids = readCredentialIds(credential);
			await safeLog(logger, {
				v: 1,
				kind: "request_completed",
				timestamp: new Date().toISOString(),
				route,
				status: 200,
				latencyMs: Date.now() - startedAt,
			});
			// Empty 200 — CLI completeMppSession only checks status. No
			// Payment-Receipt on close (the CLI submits, doesn't consume).
			return c.json(ids.channelId ? { closed: true, channelId: ids.channelId } : { closed: true });
		}
		// END CLOSE-VOUCHER PATH ────────────────────────────────────────────

		let verified: VerifiedCredential;
		try {
			verified = await verifyWithScope(app.ctx.mppx, credential, opts.scope);
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
			return sendSessionChallenge(app, c, { ...challengeOpts, detail });
		}

		const payer = await payerFromCredential(app.ctx.mppxChannelStore, verified);
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
			return sendSessionChallenge(app, c, {
				...challengeOpts,
				detail: "channel_state_missing_after_verify",
			});
		}

		// Settle hook — handler calls this before returning. Last write wins.
		// We do NOT clamp here; clamping happens once at receipt-emit time so
		// a handler that calls settle multiple times sees its raw values.
		//
		// `frozen` flips true the moment `await next()` returns. After that,
		// the receipt is about to be encoded and `channel.spent` overridden;
		// a late settle (setImmediate, unawaited Promise) cannot reach the
		// wire, so we ignore it and log so the bug surfaces in audit.
		let settled: bigint | null = null;
		let frozen = false;
		const settle = (actualAmount: bigint) => {
			if (frozen) {
				void safeLog(logger, {
					v: 1,
					kind: "payment_failed",
					timestamp: new Date().toISOString(),
					protocol: "mpp",
					stage: "settle",
					reason: `metered_late_settle_ignored:${actualAmount}`,
					scope: opts.scope,
					route,
				});
				return;
			}
			settled = actualAmount;
		};

		c.set("payer", payer);
		c.set("verifiedCredential", verified);
		c.set("settle", settle);

		let handlerError: unknown = undefined;
		let caughtHandlerError = false;
		try {
			await next();
		} catch (err) {
			handlerError = err;
			caughtHandlerError = true;
		}
		if (handlerError === undefined && c.error !== undefined) {
			handlerError = c.error;
		}
		frozen = true;

		// Streaming-abort fallback: if the client disconnected mid-handler and
		// the handler didn't call settle, default the actual to `0n` (buyer
		// received nothing of value) instead of `maxAmount`. Handlers that
		// want to bill partial work on abort should observe `c.req.raw.signal`
		// themselves and call `settle(actualUsage)` in their abort path —
		// this fallback only catches the "handler didn't observe abort" case.
		const signalAborted = c.req.raw.signal?.aborted ?? false;
		const responseFailed = handlerError !== undefined || (c.res?.status ?? 0) >= 400;
		const fallback = settled === null;
		// Explicit settlement always wins. Otherwise, successful responses keep
		// the existing maxAmount fallback so the seller is not silently
		// underpaid, while failed responses and aborted requests close at zero
		// so validation/upstream failures do not overbill the buyer by default.
		const rawActual = settled ?? (responseFailed || signalAborted ? 0n : opts.maxAmount);
		// Clamp upward at maxAmount — the buyer's voucher only covers max,
		// any excess is the seller's bug or the seller's gift. Logged.
		const clamped = rawActual > opts.maxAmount;
		const finalAmount = clamped ? opts.maxAmount : rawActual < 0n ? 0n : rawActual;
		// Expose the canonical settled amount on c.var so outer middlewares
		// (usage loggers, billing rollups) can read the same value the
		// receipt encodes without re-implementing the clamp/floor logic.
		c.set("settledAmount", finalAmount);

		const ids = readCredentialIds(credential);
		if (ids.channelId && ids.challengeId) {
			const receipt: SessionReceiptPayload = {
				channelId: ids.channelId,
				challengeId: ids.challengeId,
				acceptedCumulative: finalAmount.toString(),
				spent: finalAmount.toString(),
				// Tells the buyer's CLI to skip the open-time deposit floor and
				// sign close at `acceptedCumulative` (= the metered actual).
				// Without this, CLIs default to the safer max(receipt, deposit)
				// policy and the refund silently doesn't happen.
				metered: true,
			};
			c.header("Payment-Receipt", encodeSessionReceipt(receipt));
			// Overwrite mppx's auto-charge of channel.spent (which always
			// charges request.amount = maxAmount per voucher) with the
			// metered actual. Without this, when the buyer's CLI later
			// posts a close voucher at `actual`, mppx's handleClose rejects
			// it ("close voucher amount must be >= <maxAmount> (spent)").
			// Last-write-wins: if the handler called settle() multiple times,
			// we use the final value, matching the receipt above.
			try {
				await app.ctx.mppxChannelStore.updateChannel(ids.channelId as Hex, (current) => {
					if (!current) return null;
					if (current.finalized) return current;
					return { ...current, spent: finalAmount };
				});
			} catch (err) {
				await safeLog(logger, {
					v: 1,
					kind: "payment_failed",
					timestamp: new Date().toISOString(),
					protocol: "mpp",
					stage: "settle",
					reason:
						err instanceof Error
							? `metered_spent_override_failed:${err.message}`
							: "metered_spent_override_failed",
					scope: opts.scope,
					route,
				});
			}
		}
		// If channelId/challengeId are missing the credential isn't a session
		// voucher — that should be impossible after verifyWithScope on a session
		// scope, but we don't crash the response over it. Logged below.

		const fp = shortFingerprint(await fingerprintCredential(header ?? ""));
		await safeLog(logger, {
			v: 1,
			kind: "payment_metered_settled",
			timestamp: new Date().toISOString(),
			protocol: "mpp",
			payer,
			seller: app.ctx.mppx?.account?.address ?? ("0x" as Hex),
			maxAmountUsdcMicro: opts.maxAmount.toString(),
			actualAmountUsdcMicro: finalAmount.toString(),
			fallback,
			aborted: signalAborted,
			route,
			scope: opts.scope,
			...(opts.meta?.sku ? { sku: opts.meta.sku } : {}),
			latencyMs: Date.now() - startedAt,
			credentialFingerprint: fp,
			...(ids.channelId ? { channelId: ids.channelId } : {}),
		});
		if (clamped) {
			await safeLog(logger, {
				v: 1,
				kind: "payment_failed",
				timestamp: new Date().toISOString(),
				protocol: "mpp",
				stage: "settle",
				reason: `metered_actual_exceeded_max:${rawActual}>${opts.maxAmount}`,
				scope: opts.scope,
				route,
			});
		}
		if (caughtHandlerError) {
			throw handlerError;
		}
	};
};
