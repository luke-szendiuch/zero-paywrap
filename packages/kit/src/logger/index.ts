/**
 * Runtime-agnostic logging hook.
 *
 * The kit emits structured events at well-defined points (402 returned,
 * settlement, failure, request completion). Consumers wire the events to
 * whatever sink fits their runtime — stdout JSON for Render, Cloudflare
 * Analytics Engine, Datadog, etc. The kit does not depend on any specific
 * sink.
 *
 * Privacy invariants enforced at the type level:
 * - The raw `Payment …` Authorization header NEVER appears in any event.
 *   Only the first 16 hex chars of `fingerprintCredential` are surfaced.
 * - No private keys, no signatures. Payer addresses are public on-chain.
 */

export type Hex = `0x${string}`;

export type PaywrapLogEventBase = {
	/** Schema version. Bump when fields change so consumers can branch. */
	v: 1;
	timestamp: string;
};

export type PaymentRequiredEvent = PaywrapLogEventBase & {
	kind: "payment_required";
	protocol: "mpp" | "x402";
	/** `${method} ${path}`, e.g. `POST /v1/sandboxes`. */
	route: string;
	scope: string;
	/** Only present for MPP. */
	intent?: "session" | "charge" | "proof";
	/** Stringified bigint micro-USDC; absent for proof intent. */
	amountUsdcMicro?: string;
	meta?: Record<string, string>;
};

export type PaymentSettledEvent = PaywrapLogEventBase & {
	kind: "payment_settled";
	protocol: "mpp" | "x402";
	payer: Hex;
	seller: Hex;
	amountUsdcMicro: string;
	route: string;
	scope?: string;
	sku?: string;
	latencyMs: number;
	/** First 16 hex chars of `fingerprintCredential(rawHeader)`. */
	credentialFingerprint?: string;
	/** x402 only — and on MPP charge once mppx surfaces it. */
	txHash?: string;
	/** x402 only — CAIP-2 network id. */
	network?: string;
	/** MPP session only. */
	sessionId?: string;
};

export type PaymentFailedEvent = PaywrapLogEventBase & {
	kind: "payment_failed";
	protocol: "mpp" | "x402";
	stage: "verify" | "settle" | "precheck" | "unknown";
	reason: string;
	scope?: string;
	route?: string;
};

export type RequestCompletedEvent = PaywrapLogEventBase & {
	kind: "request_completed";
	route: string;
	status: number;
	latencyMs: number;
	payer?: Hex;
};

/**
 * Emitted by `mppMetered()` after the handler returns. `actualAmountUsdcMicro`
 * is what we encoded into the `Payment-Receipt` header (and thus what the
 * buyer's CLI signs into the close voucher). `maxAmountUsdcMicro` is the
 * upper-bound the voucher already covered — the gap (`max - actual`) is
 * unused headroom that gets refunded to the buyer on close.
 *
 * Pair with `payment_settled` for non-metered routes; downstream sinks
 * (D1, Datadog) can union both for utilization audits.
 */
export type PaymentMeteredSettledEvent = PaywrapLogEventBase & {
	kind: "payment_metered_settled";
	protocol: "mpp";
	payer: Hex;
	seller: Hex;
	maxAmountUsdcMicro: string;
	actualAmountUsdcMicro: string;
	/** True iff handler did not call `c.var.settle(...)` — fell back to max. */
	fallback: boolean;
	route: string;
	scope?: string;
	sku?: string;
	latencyMs: number;
	credentialFingerprint?: string;
	channelId?: string;
};

export type PaywrapLogEvent =
	| PaymentRequiredEvent
	| PaymentSettledEvent
	| PaymentMeteredSettledEvent
	| PaymentFailedEvent
	| RequestCompletedEvent;

export type LoggerCallback = (event: PaywrapLogEvent) => void | Promise<void>;

/**
 * Default logger: one JSON line per event on stdout (or stderr for failures).
 * Captured by `wrangler tail` (Workers), Render's log viewer, journalctl, etc.
 */
export const consoleJsonLogger: LoggerCallback = (event) => {
	const line = JSON.stringify(event);
	if (event.kind === "payment_failed") {
		console.error(line);
	} else {
		console.log(line);
	}
};

/**
 * Wrap a logger so a thrown / rejected logger never escapes into the request
 * path. A flaky sink (Datadog 5xx, network blip) must not break a paid call.
 *
 * Adapters use this internally before invoking the consumer's logger.
 */
export const safeLog = async (
	logger: LoggerCallback | undefined,
	event: PaywrapLogEvent,
): Promise<void> => {
	if (!logger) return;
	try {
		await logger(event);
	} catch {
		// swallow — observability must never break the hot path
	}
};

/**
 * Truncate a 32-byte hex digest down to the 16-char fingerprint we surface
 * in events. `fingerprintCredential` returns the full 64-char hex; we keep
 * only the leading 16 chars to match what services typically use as charge
 * dedup keys (see daytona's `defaultSandboxName`).
 */
export const shortFingerprint = (digest: string): string => digest.slice(0, 16);

/**
 * Standard reason buckets for `paywrap_refund_owed` events. Refund triage
 * (operator scripts, dashboards, ledger reconciliation) groups by these,
 * so adding a new bucket is a contract change — prefer putting service-
 * specific detail in the event's `details` field instead of inventing a
 * new reason.
 *
 * - `upstream_5xx` — upstream returned a 5xx after settlement.
 * - `upstream_4xx_post_settlement` — upstream returned 4xx for a request
 *   the service should have caught in `preCheck` but didn't.
 * - `upstream_timeout` — network/socket timeout to the upstream.
 * - `upstream_rate_limit` — upstream returned 429.
 * - `worker_crash` — handler threw / process died after settlement.
 * - `post_settlement_validation` — validation only possible after the
 *   paid side-effect began (e.g. content moderation on generated output).
 * - `unknown` — fallback when none of the above fit; explain in `details`.
 */
export type RefundReason =
	| "upstream_5xx"
	| "upstream_4xx_post_settlement"
	| "upstream_timeout"
	| "upstream_rate_limit"
	| "worker_crash"
	| "post_settlement_validation"
	| "unknown";

/**
 * Refund-owed event shape. The `msg: "paywrap_refund_owed"` discriminator
 * is a fixed grep key — operators run `grep paywrap_refund_owed` across
 * log streams to build a refund queue. Do not change it.
 *
 * Note: this is intentionally NOT part of `PaywrapLogEvent`. The structured
 * event union is for observability sinks (Datadog, Analytics Engine);
 * refund-owed is for operator action queues. Different consumer, different
 * shape (`msg` vs `kind`), different sink (always stderr).
 */
export type RefundOwedEvent = {
	msg: "paywrap_refund_owed";
	v: 1;
	timestamp: string;
	payer: Hex;
	sku: string;
	amountUsdcMicro: string;
	reason: RefundReason;
	/** Free-form sub-reason context. Stringify carefully — gets logged verbatim. */
	details?: Record<string, unknown>;
	/**
	 * Charge tx hash (MPP charge intent) or first 16 hex chars of
	 * `fingerprintCredential(rawHeader)`. Whichever your route already
	 * computes for idempotency. Lets operators dedupe a retry storm.
	 */
	chargeHash?: string;
	/** Optional route identifier — `${method} ${path}`. */
	route?: string;
};

/** Input to `logRefundOwed` — `timestamp` + `msg` + `v` are filled in for you. */
export type RefundOwedInput = Omit<RefundOwedEvent, "msg" | "v" | "timestamp"> & {
	/** Override the default ISO timestamp. Useful for tests / replay. */
	timestamp?: string;
};

/**
 * Emit a `paywrap_refund_owed` line to stderr in the canonical shape.
 * Use this for post-settlement failures you would not intentionally bill
 * for (upstream 5xx, timeouts, worker crashes, etc.). Never emit it for
 * `preCheck` rejections — those happen before settlement.
 *
 * Defaults to `console.error`. Pass `sink` to redirect (tests, custom
 * transports). The sink receives the already-stringified JSON line.
 *
 * Never logs the raw `Payment …` Authorization header. Pass `chargeHash`
 * (a tx hash or `shortFingerprint(fingerprintCredential(header))`) when
 * you have one — operators use it to dedupe retries.
 *
 * Returns the emitted event so callers can pipe it elsewhere (a separate
 * structured-events sink, an audit table, etc.) without re-deriving fields.
 */
export const logRefundOwed = (
	input: RefundOwedInput,
	sink: (line: string) => void = (line) => console.error(line),
): RefundOwedEvent => {
	const event: RefundOwedEvent = {
		msg: "paywrap_refund_owed",
		v: 1,
		timestamp: input.timestamp ?? new Date().toISOString(),
		payer: input.payer,
		sku: input.sku,
		amountUsdcMicro: input.amountUsdcMicro,
		reason: input.reason,
		...(input.details !== undefined && { details: input.details }),
		...(input.chargeHash !== undefined && { chargeHash: input.chargeHash }),
		...(input.route !== undefined && { route: input.route }),
	};
	try {
		sink(JSON.stringify(event));
	} catch {
		// observability must never break the hot path
	}
	return event;
};

/**
 * Fan a single event out to multiple sinks. Each logger runs concurrently
 * and is wrapped in try/catch so a flaky destination (Datadog 5xx, KV
 * eviction, etc.) can't take down the rest. `safeLog` is already
 * applied per-callsite by adapters, but composing also wraps so this is
 * safe to use in any order.
 *
 * Usage:
 *   const logger = composeLoggers([
 *     consoleJsonLogger,                    // stdout
 *     d1Logger(env.SETTLEMENTS_DB, ...),    // durable
 *     datadogLogger(env.DD_API_KEY),        // dashboards
 *   ]);
 *   createPaywrapMpp({ ..., logger });
 *
 * Single-element arrays are returned as-is (no wrapping cost).
 */
export const composeLoggers = (loggers: LoggerCallback[]): LoggerCallback => {
	if (loggers.length === 0) return async () => undefined;
	const single = loggers[0];
	if (loggers.length === 1 && single) return single;
	return async (event: PaywrapLogEvent) => {
		await Promise.all(loggers.map((l) => safeLog(l, event)));
	};
};
