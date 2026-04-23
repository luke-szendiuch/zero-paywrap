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
};

export type FreeRoute = {
	method: string;
	path: string;
	description?: string;
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
