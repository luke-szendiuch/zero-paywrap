export const buildAppTemplate = (): string => `import Fastify from "fastify";
import {
\ttype ZodTypeProvider,
\tserializerCompiler,
\tvalidatorCompiler,
} from "fastify-type-provider-zod";
import type { AppContext } from "./app-context.js";

/**
 * Assemble the Fastify app and stash the shared context on it. Routes read
 * \`app.ctx\` for env, mppx, the channel store, and any services the scaffold
 * wired up.
 */
export const buildApp = async (ctx: AppContext) => {
\tconst app = Fastify({
\t\tlogger: { level: ctx.env.LOG_LEVEL },
\t}).withTypeProvider<ZodTypeProvider>();
\tapp.setValidatorCompiler(validatorCompiler);
\tapp.setSerializerCompiler(serializerCompiler);
\tapp.decorate("ctx", ctx);
\treturn app;
};

declare module "fastify" {
\tinterface FastifyInstance {
\t\tctx: AppContext;
\t}
}
`;
