import Fastify, { type FastifyInstance } from "fastify";
import {
	type ZodTypeProvider,
	serializerCompiler,
	validatorCompiler,
} from "fastify-type-provider-zod";
import { registerMppGated } from "./gated.js";

/**
 * AppContext base. Consumers parameterize `T` with their full context
 * (env, db, services, ...). The adapter only reads `logger`.
 */
// biome-ignore lint/suspicious/noExplicitAny: consumer logger shape not constrained here
export type AppContextBase = { logger: any };

/**
 * Build a fastify instance preconfigured for a paywrap service:
 *   - pino logger via `loggerInstance`
 *   - Zod type provider + validator/serializer compilers
 *   - `app.ctx` decorated with the caller's context
 *   - `app.mppGated(...)` factory attached
 *
 * Consumers register routes on the returned instance separately so they own
 * plugin order without forking this adapter.
 */
export const createFastifyApp = <T extends AppContextBase>(ctx: T): FastifyInstance => {
	// Fastify 5: `logger` = config object → Fastify builds pino;
	// `loggerInstance` = pre-built pino handed in. Consumers ship pre-built.
	const app = Fastify({ loggerInstance: ctx.logger }).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	// Widen to `unknown` so TS picks the plain-value decorate() overload;
	// the GetterSetter overload misfires on generic T.
	app.decorate("ctx", ctx as unknown);
	registerMppGated(app);
	return app;
};
