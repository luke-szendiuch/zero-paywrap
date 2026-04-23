/**
 * Shape of the `.well-known/paywrap.json` document a paid service publishes.
 *
 * This is the protocol-level service-discovery manifest Zero (and any other
 * indexer) reads to learn: what routes cost money, what they cost, what
 * wallet receives payment, and what protocol secures each route.
 *
 * `protocol` is a per-route tag so a single service can mix MPP and x402
 * routes (future). The top-level `wallet` is the default receiver for
 * services where every paid route settles to the same address.
 */
export type PaidRoute = {
	method: string;
	path: string;
	/** Protocol that secures this route. Extend the union as we add more. */
	protocol: "mpp" | "x402";
	/** SKU id — opaque string the seller uses to version/identify the unit. */
	sku: string;
	priceUsdcMicro: string;
	pricingVersion: number;
	description: string;
	/** Per-route wallet override; falls back to the top-level wallet. */
	wallet?: string;
};

export type FreeRoute = {
	method: string;
	path: string;
	description?: string;
};

export type PaywrapManifest = {
	/** Default payout wallet; per-route `wallet` overrides this. */
	wallet: string;
	paidRoutes: PaidRoute[];
	freeRoutes: FreeRoute[];
};

/**
 * Build the JSON document served at `/.well-known/paywrap.json`. Pure —
 * doesn't touch the network or the DB. Services wire it up to their own
 * router:
 *
 *   app.get('/.well-known/paywrap.json', () => buildPaywrapJson(config));
 *
 * If the paywrap spec later adds required fields, kit bumps will pick them
 * up automatically; services that type-check against this return shape get
 * compile-time coverage of the change.
 */
export const buildPaywrapJson = (config: PaywrapManifest): PaywrapManifest => ({
	wallet: config.wallet,
	paidRoutes: config.paidRoutes,
	freeRoutes: config.freeRoutes,
});
