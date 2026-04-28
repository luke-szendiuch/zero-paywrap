import type { RouteConfig } from "@x402/core/server";
import { x402HTTPResourceServer } from "@x402/core/server";

type PaymentOption = NonNullable<RouteConfig["accepts"]> extends infer A
	? A extends Array<infer T>
		? T
		: A
	: never;
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { safeLog } from "@zeroclickai/paywrap/logger";
import type { PaywrapX402 } from "@zeroclickai/paywrap/x402";
import { x402NetworkId, x402UsdcAsset } from "@zeroclickai/paywrap/x402";
import type { MiddlewareHandler } from "hono";

export type X402GatedOptions = {
	/**
	 * USD price as a Money value (string or number). x402's exact-evm scheme
	 * converts to micro-USDC at request time. Examples: `"0.005"`, `0.05`.
	 *
	 * For non-USDC assets, pass an `AssetAmount`-shaped `accepts` directly via
	 * `acceptsOverride`.
	 */
	price: string | number;
	/**
	 * Override the seller `payTo` from `createPaywrapX402`. Most services pin
	 * a single wallet at the factory level and don't set this.
	 */
	payTo?: `0x${string}`;
	/** Human-readable description for the 402 paywall / `RouteConfig.description`. */
	description?: string;
	/** MIME type sent in the unpaid-response `RouteConfig.mimeType`. */
	mimeType?: string;
	/**
	 * Resource URL advertised in `paymentRequirements`. Defaults to the request
	 * URL at runtime (x402 fills this from `getUrl()`); set explicitly to pin a
	 * canonical resource id (e.g. when behind a proxy / CDN).
	 */
	resource?: string;
	/**
	 * Drop-in escape hatch for routes that need extra schemes/networks/extensions
	 * beyond the standard exact-evm config. When provided, replaces the
	 * auto-generated `accepts` array entirely.
	 */
	acceptsOverride?: PaymentOption | PaymentOption[];
	/**
	 * x402 facilitator sync runs on first request to fetch supported kinds.
	 * Disable for offline tests; defaults to `true`.
	 */
	syncFacilitatorOnStart?: boolean;
};

/**
 * Hono middleware that gates a route via x402. Built on `@x402/hono`'s
 * `paymentMiddlewareFromHTTPServer` — we just narrow the surface to a single
 * route + the kit's `PaywrapX402` factory output.
 *
 * Mirrors `mppGated`'s shape so a service can register either (or both):
 *
 *   const x402 = createPaywrapX402({ payTo, network: 'base' });
 *   app.post('/generate', x402Gated(x402, { price: '0.005' }), handler);
 *
 * Settlement happens in the facilitator round-trip; on success the buyer's
 * `PAYMENT-SIGNATURE` header is consumed and the handler runs.
 */
export const x402Gated = (x402: PaywrapX402, opts: X402GatedOptions): MiddlewareHandler => {
	const accepts: PaymentOption | PaymentOption[] =
		opts.acceptsOverride ??
		({
			scheme: "exact",
			network: x402NetworkId(x402.network),
			payTo: opts.payTo ?? x402.payTo,
			price: opts.price,
			extra: { asset: x402UsdcAsset(x402.network) },
		} satisfies PaymentOption);

	const route: RouteConfig = {
		accepts,
		...(opts.description !== undefined ? { description: opts.description } : {}),
		...(opts.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
		...(opts.resource !== undefined ? { resource: opts.resource } : {}),
	};

	const httpServer = new x402HTTPResourceServer(x402.resourceServer, route);
	const inner = paymentMiddlewareFromHTTPServer(
		httpServer,
		undefined,
		undefined,
		opts.syncFacilitatorOnStart ?? true,
	);
	const logger = x402.logger;
	if (!logger) return inner;

	// Wrap to emit `payment_required` (when the inner middleware returns 402)
	// and `request_completed` (latency + status). `payment_settled` /
	// `payment_failed` come from the kit factory's hooks on `resourceServer`.
	// Hono middleware contract: must return the inner Response when the inner
	// middleware short-circuits, or just resolve when it called `next()` and
	// the framework finalized the response.
	return async (c, next) => {
		const startedAt = Date.now();
		const routeStr = `${c.req.method} ${c.req.path}`;
		const result = await inner(c, next);
		const status = result instanceof Response ? result.status : c.res.status;
		if (status === 402) {
			await safeLog(logger, {
				v: 1,
				kind: "payment_required",
				timestamp: new Date().toISOString(),
				protocol: "x402",
				route: routeStr,
				scope: opts.description ?? routeStr,
				...(typeof opts.price === "string" || typeof opts.price === "number"
					? { amountUsdcMicro: String(opts.price) }
					: {}),
			});
		}
		await safeLog(logger, {
			v: 1,
			kind: "request_completed",
			timestamp: new Date().toISOString(),
			route: routeStr,
			status,
			latencyMs: Date.now() - startedAt,
		});
		return result;
	};
};
