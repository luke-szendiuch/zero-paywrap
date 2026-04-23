import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const routesHealthTemplate = (config: ScaffoldConfig): string => {
	const usePg = config.storage === "postgres-drizzle";
	const useRedis = config.queue === "bullmq-redis";
	const probes: string[] = [];
	if (usePg) {
		probes.push(`\t\t\t\tdb: async () => {
\t\t\t\t\t// biome-ignore lint/suspicious/noExplicitAny: drizzle client types differ per dialect
\t\t\t\t\tawait (app.ctx.db as any).execute("select 1");
\t\t\t\t\treturn "up" as const;
\t\t\t\t},`);
	}
	if (useRedis) {
		probes.push(`\t\t\t\tredis: async () => {
\t\t\t\t\tif (!app.ctx.mppxRedis) return "down" as const;
\t\t\t\t\treturn (await app.ctx.mppxRedis.ping()) === "PONG" ? ("up" as const) : ("down" as const);
\t\t\t\t},`);
	}
	if (probes.length === 0) {
		// Always-up probe so the route returns a stable 200.
		probes.push(`\t\t\t\tself: () => "up" as const,`);
	}

	return `import { aggregateHealthProbes } from "@zeroclickai/paywrap/health";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/**
 * Liveness + readiness. Returns 200 when every probe reports "up", 503 otherwise.
 * Uses the kit's \`aggregateHealthProbes\` so the body shape stays consistent with
 * any other paywrap-powered service.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
\tapp.get("/", async (_req, reply) => {
\t\tconst { status, body } = await aggregateHealthProbes({
\t\t\tprobes: {
${probes.join("\n")}
\t\t\t},
\t\t\textras: { wallet: app.ctx.walletAddress },
\t\t});
\t\treturn reply.status(status).send(body);
\t});
};
`;
};
