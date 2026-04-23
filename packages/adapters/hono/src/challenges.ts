import {
	buildChargeChallenge,
	buildProofChallenge,
	buildSessionChallenge,
	extractCredential as kitExtractCredential,
} from "@zerorun/paywrap/auth";
import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import type { Context } from "hono";

/**
 * Framework-facing challenge helpers for Hono. The kit produces a
 * `{status, headers, body}` descriptor from every challenge builder; this
 * module does the one-time mapping onto Hono's `Context` response API so
 * each service's route code stays small and consistent.
 *
 * Keep this file narrow. Anything here must be a Hono-specific
 * transformation of something the core kit already decides — no business
 * rules (pricing, scope strings, DB lookups) belong here.
 */

type ChallengeDescriptor = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
};

// Hono's Context has a loose response type; we don't care about the schema
// shape the consumer binds.
// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
type AnyContext = Context<any, any, any>;

const applyDescriptor = (c: AnyContext, descriptor: ChallengeDescriptor): Response => {
	for (const [name, value] of Object.entries(descriptor.headers)) {
		c.header(name, value);
	}
	// Hono's `c.json` accepts any JSON-serializable body + a numeric status.
	// `any` below because `c.json` types the status as a `StatusCode` union —
	// we trust the kit to produce valid ones (402 for every challenge path).
	// biome-ignore lint/suspicious/noExplicitAny: StatusCode union from hono is internal
	return c.json(descriptor.body as any, descriptor.status as any);
};

// `AppLike` captures only the parts of a consumer ctx this adapter needs:
// `ctx.mppx`. Everything else on ctx is opaque.
type AppLike = { ctx: { mppx: PaywrapMpp["mppx"] } };

/**
 * Issue a 402 `tempo.session` paid challenge. Used by POST / extend
 * routes so clients know what channel-open invitation to respond to.
 */
export const sendSessionChallenge = async (
	app: AppLike,
	c: AnyContext,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
		suggestedDeposit?: bigint | string;
		unitType?: string;
	},
): Promise<Response> => {
	const descriptor = await buildSessionChallenge(app.ctx.mppx, opts);
	return applyDescriptor(c, descriptor);
};

/**
 * Issue a 402 `tempo.charge` single-shot paid challenge. Used by paid
 * routes that don't need session semantics (pay-per-call, no voucher
 * ledger).
 */
export const sendChargeChallenge = async (
	app: AppLike,
	c: AnyContext,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
): Promise<Response> => {
	const descriptor = await buildChargeChallenge(app.ctx.mppx, opts);
	return applyDescriptor(c, descriptor);
};

/**
 * Issue a 402 `tempo.charge` (amount="0") "proof credential" challenge.
 * Used by read/delete routes that need wallet-authz without payment.
 */
export const sendProofChallenge = async (
	app: AppLike,
	c: AnyContext,
	scope: string,
	detail: string,
	meta?: Record<string, string>,
): Promise<Response> => {
	const descriptor = await buildProofChallenge(app.ctx.mppx, {
		scope,
		detail,
		...(meta ? { meta } : {}),
	});
	return applyDescriptor(c, descriptor);
};

/**
 * Parse a `Payment` / `Authorization` header into an mppx credential.
 *
 * Re-exported from the kit so Hono consumers keep a single adapter import
 * surface. Pure / framework-agnostic.
 */
export const extractCredential = kitExtractCredential;
