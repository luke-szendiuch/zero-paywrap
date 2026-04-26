/**
 * Refund bookkeeping primitives for charge-intent services.
 *
 * Charge-intent has a known sharp edge: settlement happens during
 * `mppx.verifyCredential`, before the service's handler runs. If the
 * upstream call (Netlify upload, JigsawStack request, Daytona create)
 * fails AFTER settlement, the buyer paid for nothing. Refunding
 * automatically would double-spend on Tempo if the verifyCredential
 * already broadcast — so refunds are operator-driven, out of band.
 *
 * What the kit can standardize: the LOG SHAPE consumers emit when a
 * refund-eligible failure happens. A predictable shape across services
 * lets a single "scan logs → reconcile refunds" job handle every
 * paywrap-backed service uniformly. Without this, each service author
 * rolls their own ad-hoc log format and the operator script has to
 * special-case every integration.
 *
 * This module ships the shape + a tiny emitter. Consumers call:
 *
 *   recordRefundOwed({
 *     payer: "0x…",
 *     sku: "jigsaw-image-gen:v2",
 *     amountUsdcMicro: 50_000n,
 *     reason: "upstream_5xx",
 *     details: { upstreamStatus: 503 },
 *   });
 *
 * It writes one line of structured JSON to `console.error` (Workers
 * surfaces this in `wrangler tail` and Render in its log stream — both
 * consumable by an operator's grep loop).
 *
 * Worker-safe: console-only, no Node imports.
 */

export type RefundOwedRecord = {
	payer: string;
	sku: string;
	/** Amount in micro-USDC. bigint in/string out so the JSON line stays parseable. */
	amountUsdcMicro: bigint;
	/** Short snake_case reason — used as the operator's primary filter. */
	reason: string;
	/** Optional context — keep small + JSON-safe. */
	details?: Record<string, unknown>;
	/** Optional stable id — usually the charge-credential fingerprint. */
	chargeHash?: string;
	/** ISO timestamp; defaults to `new Date().toISOString()`. */
	timestamp?: string;
};

/**
 * Emit a structured refund-owed log line. Consumers should call this
 * exactly once per refund-eligible failure (typically an upstream 5xx
 * after settlement, or a post-settle local error like a malformed
 * upload).
 *
 * The log shape is the contract — keep field names stable.
 */
export const recordRefundOwed = (record: RefundOwedRecord): void => {
	const line = {
		msg: "paywrap_refund_owed",
		payer: record.payer,
		sku: record.sku,
		amountUsdcMicro: record.amountUsdcMicro.toString(),
		reason: record.reason,
		...(record.chargeHash ? { chargeHash: record.chargeHash } : {}),
		...(record.details ? { details: record.details } : {}),
		timestamp: record.timestamp ?? new Date().toISOString(),
	};
	// Use console.error so log shippers (wrangler tail, Render logs, pino's
	// stderr split) treat it as actionable. The operator's reconciliation
	// script greps on `paywrap_refund_owed`.
	console.error(JSON.stringify(line));
};
