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

export type PaywrapLogEvent =
	| PaymentRequiredEvent
	| PaymentSettledEvent
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
