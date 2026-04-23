import {
	buildChargeChallenge,
	buildProofChallenge,
	buildSessionChallenge,
	extractCredential as kitExtractCredential,
} from "@zeroclickai/paywrap/auth";
import type { PaywrapMpp } from "@zeroclickai/paywrap/mpp";
import type { Context } from "hono";

// The kit produces a `{status, headers, body}` descriptor; this module maps
// it onto Hono's `Context` response API. No business rules here.

type ChallengeDescriptor = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
};

// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
type AnyContext = Context<any, any, any>;

const applyDescriptor = (c: AnyContext, descriptor: ChallengeDescriptor): Response => {
	for (const [name, value] of Object.entries(descriptor.headers)) {
		c.header(name, value);
	}
	// `c.json` types status as an internal StatusCode union — we trust the
	// kit to produce valid ones (402 for every challenge path).
	// biome-ignore lint/suspicious/noExplicitAny: StatusCode union from hono is internal
	return c.json(descriptor.body as any, descriptor.status as any);
};

type AppLike = { ctx: { mppx: PaywrapMpp["mppx"] } };

/** 402 `tempo.session` paid challenge — POST / extend routes. */
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
): Promise<Response> => applyDescriptor(c, await buildSessionChallenge(app.ctx.mppx, opts));

/** 402 `tempo.charge` single-shot paid challenge — no voucher ledger. */
export const sendChargeChallenge = async (
	app: AppLike,
	c: AnyContext,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
): Promise<Response> => applyDescriptor(c, await buildChargeChallenge(app.ctx.mppx, opts));

/** 402 `tempo.charge` (amount="0") proof challenge — wallet auth. */
export const sendProofChallenge = async (
	app: AppLike,
	c: AnyContext,
	scope: string,
	detail: string,
	meta?: Record<string, string>,
): Promise<Response> =>
	applyDescriptor(
		c,
		await buildProofChallenge(app.ctx.mppx, {
			scope,
			detail,
			...(meta ? { meta } : {}),
		}),
	);

/** Re-export so Hono consumers keep a single import surface. */
export const extractCredential = kitExtractCredential;
