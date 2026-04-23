import Fastify, { type FastifyInstance } from "fastify";
import {
	type ZodTypeProvider,
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";
import { registerMppGated } from "./gated.js";

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
 *   - `app.mppGated(...)` factory attached
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
	// Register the `app.mppGated(...)` preHandler factory. Kept optional at
	// the ctx level — consumers whose ctx doesn't carry mppx will simply
	// never call it. The factory throws clearly at registration time if
	// required options are missing.
	registerMppGated(app);
	return app;
};

/**
 * Alias export so consumers who prefer explicit imports can do
 * `import { mppGated } from '@zerorun/paywrap-adapter-fastify'` even though
 * the actual factory is attached per-app via `app.mppGated(...)`. The
 * default pattern remains `app.mppGated(...)` — this re-export is a
 * documentation marker, not a different code path.
 */
export const mppGated = (): never => {
	throw new Error(
		"paywrap/mppGated: use `app.mppGated({...})` — the factory is attached to the fastify instance by createFastifyApp()",
	);
};
