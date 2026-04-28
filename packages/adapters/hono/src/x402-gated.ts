import { decodePaymentSignatureHeader } from "@x402/core/http";
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
import type { Hex } from "viem";

/**
 * Variables `x402Gated` sets on Hono's `c.var` so handlers can read the
 * verified buyer wallet — mirrors `mppGated`'s `payer`. Augment your Hono
 * Variables type to narrow the read:
 *
 *   const app = new Hono<{ Variables: PaywrapVariables & X402Variables }>();
 *   app.post("/x", x402Gated(x402, { ... }), (c) => {
 *     const buyer = c.var.x402Payer;  // typed Hex
 *   });
 */
export type X402Variables = {
	/** Verified buyer wallet for the current x402-paid request. */
	x402Payer: Hex;
};

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

	// Wrap to:
	//   1. Decode the buyer wallet from the request's payment-signature header
	//      and set it on `c.var.x402Payer`. The decode happens before verify;
	//      if verify rejects the credential the inner middleware short-circuits
	//      with 402 and the handler never runs, so a handler reading
	//      `c.var.x402Payer` always sees a verified address.
	//   2. Emit `payment_required` when inner returns 402 and `request_completed`
	//      regardless. `payment_settled` / `payment_failed` come from the kit
	//      factory's hooks on `resourceServer`.
	//
	// Hono middleware contract: return the inner Response when it short-
	// circuits; otherwise resolve to undefined so Hono finalizes the response
	// the handler set on `c.res`.
	return async (c, next) => {
		const startedAt = Date.now();
		const routeStr = `${c.req.method} ${c.req.path}`;
		const sigHeader = c.req.header("payment-signature") ?? c.req.header("x-payment") ?? null;
		if (sigHeader) {
			try {
				const payload = decodePaymentSignatureHeader(sigHeader);
				const payer = (payload as { payload?: { authorization?: { from?: string } } }).payload
					?.authorization?.from;
				if (payer) c.set("x402Payer" as never, payer as Hex as never);
			} catch {
				// malformed header — let inner middleware reject during verify
			}
		}
		const result = await inner(c, next);
		if (!logger) return result;
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
