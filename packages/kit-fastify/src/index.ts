import {
	buildChargeChallenge,
	buildProofChallenge,
	buildSessionChallenge,
} from "@zerorun/paywrap/auth";
import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import Fastify, { type FastifyInstance } from "fastify";
import {
	type ZodTypeProvider,
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";
import { Credential } from "mppx";

/**
 * Fastify adapter for `@zerorun/paywrap`. The kit returns a
 * framework-agnostic `{status, headers, body}` descriptor from every
 * challenge builder; this package does the one-time mapping onto fastify's
 * reply API so each service's route code stays small and consistent.
 *
 * Keep this file narrow. Anything here must be a fastify-specific
 * transformation of something the core kit already decides — no business
 * rules (pricing, scope strings, DB lookups) belong here.
 */

// biome-ignore lint/suspicious/noExplicitAny: fastify reply generic — adapter does not care about the schema shape
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

// `AppLike` captures only the parts of a fastify instance this adapter
// needs — `ctx.mppx`. We intentionally do NOT constrain `ctx` further:
// each consumer decorates its own shape and we don't want to force a
// mppx-shaped type here.
type AppLike = { ctx: { mppx: PaywrapMpp["mppx"] } };

/**
 * Issue a 402 `tempo.session` paid challenge. Used by POST / extend
 * routes so clients know what channel-open invitation to respond to.
 */
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
) => {
	const descriptor = await buildSessionChallenge(app.ctx.mppx, opts);
	return applyDescriptor(reply, descriptor);
};

/**
 * Issue a 402 `tempo.charge` single-shot paid challenge. Used by paid
 * routes that don't need session semantics (pay-per-call, no voucher
 * ledger).
 */
export const sendChargeChallenge = async (
	app: AppLike,
	reply: Reply,
	opts: {
		amount: bigint | string;
		scope: string;
		detail: string;
		meta?: Record<string, string>;
	},
) => {
	const descriptor = await buildChargeChallenge(app.ctx.mppx, opts);
	return applyDescriptor(reply, descriptor);
};

/**
 * Issue a 402 `tempo.charge` (amount="0") "proof credential" challenge.
 * Used by read/delete routes that need wallet-authz without payment.
 *
 * HMAC-binds `scope` into the challenge id so a credential signed for
 * one scope cannot replay against another route with a different scope.
 */
export const sendProofChallenge = async (
	app: AppLike,
	reply: Reply,
	scope: string,
	detail: string,
	meta?: Record<string, string>,
) => {
	const descriptor = await buildProofChallenge(app.ctx.mppx, {
		scope,
		detail,
		...(meta ? { meta } : {}),
	});
	return applyDescriptor(reply, descriptor);
};

/**
 * Parse a `Payment` / `Authorization` header into an mppx credential.
 *
 * mppx's `Credential.deserialize` expects the full `Payment <base64url>`
 * form and extracts the scheme itself. Callers typically pass either
 * header — an `Authorization: Payment <...>` or a bare `Payment: <...>` —
 * and this helper normalizes both.
 *
 * Returns `null` on any parse failure. Route handlers should respond with
 * a 402 challenge in that case, not a 400 — the credential shape is part
 * of the 402 contract, not a schema error.
 */
// biome-ignore lint/suspicious/noExplicitAny: Credential.deserialize is generic over payload
export const extractCredential = (header: string | undefined): any | null => {
	if (!header) return null;
	try {
		return Credential.deserialize(header.startsWith("Payment ") ? header : `Payment ${header}`);
	} catch {
		return null;
	}
};

/**
 * AppContext base shape. Consumers parameterize `T` with their full
 * context (env, db, services, ...). The adapter only requires a
 * `logger` (pino instance for fastify) — everything else is opaque.
 */
// biome-ignore lint/suspicious/noExplicitAny: consumer logger shape not constrained here
export type AppContextBase = { logger: any };

/**
 * Build a fastify instance preconfigured for a paywrap service:
 *
 *   - pre-built pino logger attached via `loggerInstance`
 *   - Zod type provider + validator/serializer compilers
 *   - `app.ctx` decorated with the caller's context
 *
 * Routes register against the returned instance separately. Keeping
 * route registration out of this factory lets consumers own their
 * plugin order without forking the adapter.
 */
export const createFastifyApp = <T extends AppContextBase>(ctx: T): FastifyInstance => {
	// Fastify 5 distinguishes `logger` (config object → Fastify builds a pino
	// instance) from `loggerInstance` (pre-built pino handed in). Consumers
	// ship a pre-built instance from their own factory, so it goes here.
	const app = Fastify({ loggerInstance: ctx.logger }).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	// Fastify 5's decorate() overload tries to match T against a GetterSetter
	// descriptor when T is a generic — widen to `unknown` so TS picks the
	// plain-value overload. Consumers augment the FastifyInstance shape in
	// their own files (see README) to expose a typed `app.ctx`.
	app.decorate("ctx", ctx as unknown);
	return app;
};
