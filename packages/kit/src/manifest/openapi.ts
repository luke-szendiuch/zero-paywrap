import type { FreeRoute, PaidRoute, PaywrapManifest } from "./index.js";

/**
 * Minimal OpenAPI 3.0 generator that derives a spec from a `PaywrapManifest`.
 *
 * Why "minimal": Zero's registration crawler (and most ecosystem indexers)
 * only need `paths` keyed by route + method to ingest a service. Rich request
 * /response schemas matter for SDK-gen tooling, but those would require
 * threading Zod schemas through `paywrap.json` first — out of scope here.
 *
 * Spec emitted:
 *   - OpenAPI 3.0.3
 *   - One path entry per paid route, one per free route
 *   - Operation summary = route.description (if present)
 *   - For paid routes, `extensions.x-paywrap` carries protocol + sku + price
 *     (preserved as `x-` so OpenAPI validators don't choke)
 *   - 200 default response with empty schema
 *   - 402 response on paid routes referencing a shared `PaymentRequired` schema
 */

export type OpenApiInfo = {
	title: string;
	version: string;
	description?: string;
};

/**
 * Hand-rolled, intentionally not a full TS port of the OpenAPI 3 spec.
 * `Record<string, unknown>` at leaves keeps the shape pliable.
 */
type OpenApiSpec = {
	openapi: "3.0.3";
	info: OpenApiInfo;
	servers: Array<{ url: string; description?: string }>;
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown> };
};

const VALID_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

const normalizeVerb = (method: string): string => {
	const lower = method.toLowerCase();
	if (!VALID_VERBS.has(lower)) {
		throw new Error(`buildOpenApiSpec: unsupported HTTP method "${method}"`);
	}
	return lower;
};

const toPathOperation = (route: PaidRoute | FreeRoute, paid: boolean): Record<string, unknown> => {
	const op: Record<string, unknown> = {
		operationId: `${normalizeVerb(route.method)}_${route.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
	};
	if (route.description) op.summary = route.description;
	const responses: Record<string, unknown> = {
		"200": {
			description: paid ? "Successful response after payment" : "Successful response",
			content: { "application/json": { schema: { type: "object" } } },
		},
	};
	if (paid) {
		responses["402"] = { $ref: "#/components/schemas/PaymentRequired" };
		op["x-paywrap"] = {
			protocol: (route as PaidRoute).protocol,
			sku: (route as PaidRoute).sku,
			priceUsdcMicro: (route as PaidRoute).priceUsdcMicro,
			pricingVersion: (route as PaidRoute).pricingVersion,
			...((route as PaidRoute).wallet ? { wallet: (route as PaidRoute).wallet } : {}),
		};
	}
	if (route.requestContentType) {
		op.requestBody = {
			content: { [route.requestContentType]: { schema: { type: "object" } } },
		};
	}
	op.responses = responses;
	return op;
};

/**
 * Build a minimal OpenAPI 3.0 spec from a PaywrapManifest.
 *
 * Pure — no I/O. Mount the result on `/openapi.json`:
 *
 *   const spec = buildOpenApiSpec(manifest, { title: "Daytona", version: "1.0" });
 *   app.get("/openapi.json", (c) => c.json(spec));
 *
 * Zero's registration crawler reads the spec from that conventional path and
 * ingests every (method, path) pair as a capability.
 */
export const buildOpenApiSpec = (
	manifest: PaywrapManifest,
	info: OpenApiInfo,
	options?: { serverUrl?: string },
): OpenApiSpec => {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const route of manifest.paidRoutes) {
		const path = paths[route.path] ?? {};
		path[normalizeVerb(route.method)] = toPathOperation(route, true);
		paths[route.path] = path;
	}
	for (const route of manifest.freeRoutes) {
		const path = paths[route.path] ?? {};
		path[normalizeVerb(route.method)] = toPathOperation(route, false);
		paths[route.path] = path;
	}

	const spec: OpenApiSpec = {
		openapi: "3.0.3",
		info,
		servers: options?.serverUrl ? [{ url: options.serverUrl }] : [],
		paths,
		components: {
			schemas: {
				PaymentRequired: {
					type: "object",
					description:
						"x402/MPP 402 advertisement. Decode the PAYMENT-REQUIRED or WWW-Authenticate header for payment requirements.",
					properties: {
						error: { type: "string" },
					},
				},
			},
		},
	};
	return spec;
};
