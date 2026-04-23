import {
	buildChargeChallenge,
	buildProofChallenge,
	buildSessionChallenge,
	extractCredential as kitExtractCredential,
} from "@zerorun/paywrap/auth";
import type { PaywrapMpp } from "@zerorun/paywrap/mpp";

// The kit produces a `{status, headers, body}` descriptor from every challenge
// builder; this module maps that onto fastify's reply API. No business rules
// (pricing, scope, DB) belong here.

// biome-ignore lint/suspicious/noExplicitAny: fastify reply generic — adapter does not care about schema shape
type Reply = any;

type ChallengeDescriptor = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
};

const applyDescriptor = (reply: Reply, descriptor: ChallengeDescriptor) => {
	let r = reply.status(descriptor.status);
	for (const [name, value] of Object.entries(descriptor.headers)) {
		r = r.header(name, value);
	}
	return r.send(descriptor.body);
};

// `AppLike` is the minimum slice of a fastify instance the adapter reads —
// `ctx.mppx`. Consumer's ctx shape is otherwise opaque.
type AppLike = { ctx: { mppx: PaywrapMpp["mppx"] } };

/** 402 `tempo.session` paid challenge — POST / extend routes. */
export const sendSessionChallenge = async (
	app: AppLike,
	reply: Reply,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
		suggestedDeposit?: bigint | string;
		unitType?: string;
	},
) => applyDescriptor(reply, await buildSessionChallenge(app.ctx.mppx, opts));

/** 402 `tempo.charge` single-shot paid challenge — no voucher ledger. */
export const sendChargeChallenge = async (
	app: AppLike,
	reply: Reply,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
) => applyDescriptor(reply, await buildChargeChallenge(app.ctx.mppx, opts));

/** 402 `tempo.charge` (amount="0") proof challenge — wallet-auth on GET/DELETE. */
export const sendProofChallenge = async (
	app: AppLike,
	reply: Reply,
	scope: string,
	detail: string,
	meta?: Record<string, string>,
) =>
	applyDescriptor(
		reply,
		await buildProofChallenge(app.ctx.mppx, {
			scope,
			detail,
			...(meta ? { meta } : {}),
		}),
	);

/** Re-export so fastify consumers keep a single import surface. */
export const extractCredential = kitExtractCredential;
