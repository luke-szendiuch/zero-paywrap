import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const routesWellKnownTemplate = (config: ScaffoldConfig): string => {
	const isSession = config.intent === "session";
	const extraRoutes = isSession
		? `\t\t\t\t{
\t\t\t\t\tmethod: "POST",
\t\t\t\t\tpath: "/v1/things/:id/extend",
\t\t\t\t\tprotocol: "mpp",
\t\t\t\t\tsku: "${config.serviceName}",
\t\t\t\t\tpriceUsdcMicro: app.ctx.env.SKU_PRICE_USDC_MICRO.toString(),
\t\t\t\t\tpricingVersion: 1,
\t\t\t\t\tdescription: "Extend an existing ${config.serviceName} session.",
\t\t\t\t},`
		: "";
	return `import { buildPaywrapJson } from "@zerorun/paywrap/manifest";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/**
 * Serve \`/.well-known/paywrap.json\`. Describes every paid + free route so
 * indexers (Zero) can discover pricing + protocol without screen-scraping.
 */
export const wellKnownRoutes: FastifyPluginAsyncZod = async (app) => {
\tapp.get("/paywrap.json", async () =>
\t\tbuildPaywrapJson({
\t\t\twallet: app.ctx.walletAddress,
\t\t\tpaidRoutes: [
\t\t\t\t{
\t\t\t\t\tmethod: "POST",
\t\t\t\t\tpath: "/v1/things",
\t\t\t\t\tprotocol: "mpp",
\t\t\t\t\tsku: "${config.serviceName}",
\t\t\t\t\tpriceUsdcMicro: app.ctx.env.SKU_PRICE_USDC_MICRO.toString(),
\t\t\t\t\tpricingVersion: 1,
\t\t\t\t\tdescription: "Create a new ${config.serviceName} resource.",
\t\t\t\t},
${extraRoutes}
\t\t\t],
\t\t\tfreeRoutes: [
\t\t\t\t{ method: "GET", path: "/v1/things/:id" },
\t\t\t\t{ method: "DELETE", path: "/v1/things/:id" },
\t\t\t],
\t\t}),
\t);
};
`;
};
