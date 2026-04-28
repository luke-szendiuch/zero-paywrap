/**
 * `.well-known/paywrap.json` — the service-discovery manifest Zero (and any
 * other indexer) reads. `protocol` is per-route so a single service can mix
 * MPP and x402 routes (future). Top-level `wallet` is the default receiver.
 */
export type PaidRoute = {
	method: string;
	path: string;
	protocol: "mpp" | "x402";
	/** SKU id — opaque string the seller uses to version/identify the unit. */
	sku: string;
	priceUsdcMicro: string;
	pricingVersion: number;
	description: string;
	/** Per-route wallet override; falls back to top-level wallet. */
	wallet?: string;
	/**
	 * Hint to buyers about what to send. Defaults to `application/json` if
	 * omitted. Set explicitly for routes that take binary uploads
	 * (`application/zip`, `application/octet-stream`) or non-JSON text
	 * (`text/csv`, `application/xml`). Buyers and the Zero catalog UI use
	 * this to render the right "how to call this" snippet without having
	 * to call the route first to discover.
	 */
	requestContentType?: string;
	/**
	 * Hint to buyers about what to expect back. Defaults to
	 * `application/json`. Set explicitly for routes that return binary
	 * (`application/pdf`, `image/png`, `audio/mpeg`) so the buyer can
	 * pre-allocate a stream/file handle and avoid trying to JSON.parse
	 * bytes. Pure metadata — does not change runtime behavior.
	 */
	responseContentType?: string;
};

export type FreeRoute = {
	method: string;
	path: string;
	description?: string;
	requestContentType?: string;
	responseContentType?: string;
};

export type PaywrapManifest = {
	wallet: string;
	paidRoutes: PaidRoute[];
	freeRoutes: FreeRoute[];
};

/**
 * Build the JSON document served at `/.well-known/paywrap.json`. Pure.
 * Typing against this return shape gives services compile-time coverage of
 * spec bumps.
 */
export const buildPaywrapJson = (config: PaywrapManifest): PaywrapManifest => ({
	wallet: config.wallet,
	paidRoutes: config.paidRoutes,
	freeRoutes: config.freeRoutes,
});

export { buildOpenApiSpec, type OpenApiInfo } from "./openapi.js";
