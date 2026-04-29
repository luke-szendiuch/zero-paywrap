import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const routesWellKnownTemplate = (config: ScaffoldConfig): string => {
	const isSession = config.intent === "session";
	const extraRoutes = isSession
		? `\t\t{
\t\t\tmethod: "POST" as const,
\t\t\tpath: "/v1/things/:id/extend",
\t\t\tprotocol: "mpp" as const,
\t\t\tsku: "${config.serviceName}",
\t\t\tpriceUsdcMicro: app.ctx.env.SKU_PRICE_USDC_MICRO.toString(),
\t\t\tpricingVersion: 1,
\t\t\tdescription: "Extend an existing ${config.serviceName} session.",
\t\t},`
		: "";
	return `import { buildOpenApiSpec, buildPaywrapJson } from "@zeroclickai/paywrap/manifest";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppContext } from "../app/app-context.js";

/**
 * Serve \`/openapi.json\` as the public discovery document. Paid routes
 * include x-payment-info plus a 402 response. \`paywrap.json\` is still
 * useful for Paywrap-aware tooling, but OpenAPI + live 402 challenge headers
 * are the interoperable contract agents should rely on.
 */
const buildManifest = (app: { ctx: AppContext }) => ({
\twallet: app.ctx.walletAddress,
\tpaidRoutes: [
\t\t{
\t\t\tmethod: "POST" as const,
\t\t\tpath: "/v1/things",
\t\t\tprotocol: "mpp" as const,
\t\t\tsku: "${config.serviceName}",
\t\t\tpriceUsdcMicro: app.ctx.env.SKU_PRICE_USDC_MICRO.toString(),
\t\t\tpricingVersion: 1,
\t\t\tdescription: "Create a new ${config.serviceName} resource.",
\t\t},
${extraRoutes}
\t],
\tfreeRoutes: [
\t\t{ method: "GET" as const, path: "/.well-known/paywrap.json" },
\t\t{ method: "GET" as const, path: "/openapi.json" },
\t\t{ method: "GET" as const, path: "/healthz" },
\t\t{ method: "GET" as const, path: "/v1/things/:id" },
\t\t{ method: "DELETE" as const, path: "/v1/things/:id" },
\t],
});

export const wellKnownRoutes: FastifyPluginAsyncZod = async (app) => {
\tapp.get("/paywrap.json", async () => buildPaywrapJson(buildManifest(app)));
};

export const openApiRoutes: FastifyPluginAsyncZod = async (app) => {
\tapp.get("/openapi.json", async () =>
\t\tbuildOpenApiSpec(
\t\t\tbuildManifest(app),
\t\t\t{
\t\t\t\ttitle: "${config.serviceName}",
\t\t\t\tversion: "1.0",
\t\t\t\tdescription: "Pay-per-call ${config.serviceName} service. Settled via paywrap.",
\t\t\t},
\t\t\t{ serverUrl: app.ctx.env.PUBLIC_BASE_URL },
\t\t),
\t);
};
`;
};
