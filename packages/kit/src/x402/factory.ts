import {
	type FacilitatorClient,
	type FacilitatorConfig,
	HTTPFacilitatorClient,
	x402ResourceServer,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { type LoggerCallback, safeLog } from "../logger/index.js";
import { type X402Network, x402NetworkId } from "./constants.js";
import { FallbackFacilitatorClient } from "./fallback-facilitator.js";

export type CreatePaywrapX402Config = {
	/** Address that receives settled USDC. */
	payTo: `0x${string}`;
	/** Which Base chain to settle on. */
	network: X402Network;
	/**
	 * Facilitator config. If omitted, defaults are picked from `network`:
	 * `base` → an ordered fallback chain `[payai, world.fun]` (both open,
	 * no API keys, both verified to settle Base mainnet — payai is primary
	 * for ecosystem maturity, world.fun is backup for ride-through during
	 * payai outages); `base-sepolia` → `https://x402.org/facilitator`. On
	 * settle failure (thrown error or `success: false`) the fallback
	 * automatically tries the next client.
	 *
	 * Pass an explicit `{ url }`, a `FacilitatorClient`, or an array of
	 * either to override the defaults.
	 */
	facilitator?:
		| FacilitatorConfig
		| FacilitatorClient
		| Array<FacilitatorConfig | FacilitatorClient>;
	/**
	 * Optional structured-event logger. The factory registers
	 * `onAfterSettle` / `onSettleFailure` hooks on the resource server to
	 * emit `payment_settled` / `payment_failed` events with the buyer
	 * wallet + tx hash. Sink-agnostic — see `@zeroclickai/paywrap/logger`.
	 */
	logger?: LoggerCallback;
};

export type PaywrapX402 = {
	/** Pre-configured x402 resource server with the exact-evm scheme registered. */
	resourceServer: x402ResourceServer;
	/** Facilitator client used by the resource server. */
	facilitator: FacilitatorClient;
	/** Address settled USDC is paid to. */
	payTo: `0x${string}`;
	/** Active network (`base` or `base-sepolia`). */
	network: X402Network;
	/** CAIP-2 id (`eip155:8453` or `eip155:84532`). */
	networkId: ReturnType<typeof x402NetworkId>;
	/** Optional logger configured at factory time. */
	logger?: LoggerCallback;
};

const isFacilitatorClient = (
	x: FacilitatorConfig | FacilitatorClient | undefined,
): x is FacilitatorClient => !!x && typeof (x as FacilitatorClient).verify === "function";

/**
 * Build the seller-side x402 primitives. Mirrors `createPaywrapMpp`'s shape:
 * one factory call returns everything an adapter needs to gate routes.
 *
 * The resource server is registered against the `eip155:*` wildcard with
 * `ExactEvmScheme` — same scheme `@x402/fetch` and the Zero CLI buyer use.
 *
 * No on-chain calls or wallet signing happen here: x402 settlement is
 * facilitator-mediated, so the seller wallet is just the receive address.
 */
// x402.org's facilitator only supports testnets (verified empirically: its
// /supported endpoint lists only eip155:84532). For mainnet we chain two
// open, no-API-key facilitators that both settle Base. payai is primary —
// most established x402 facilitator, more public usage, more eyes on
// regressions. world.fun (from AWE Network) is the failover — its signer
// 0x6Cb9... has 86k+ txs on Base, but the project is smaller / less
// battle-tested, so it sits behind payai.
const DEFAULT_FACILITATOR_URLS: Record<X402Network, string[]> = {
	base: ["https://facilitator.payai.network", "https://facilitator.world.fun"],
	"base-sepolia": ["https://x402.org/facilitator"],
};

const toClient = (entry: FacilitatorConfig | FacilitatorClient): FacilitatorClient =>
	isFacilitatorClient(entry) ? entry : new HTTPFacilitatorClient(entry);

const resolveFacilitator = (config: CreatePaywrapX402Config): FacilitatorClient => {
	const entries: Array<FacilitatorConfig | FacilitatorClient> =
		config.facilitator === undefined
			? DEFAULT_FACILITATOR_URLS[config.network].map((url) => ({ url }))
			: Array.isArray(config.facilitator)
				? config.facilitator
				: [config.facilitator];
	const clients = entries.map(toClient);
	return clients.length === 1 ? clients[0]! : new FallbackFacilitatorClient(clients);
};

export const createPaywrapX402 = (config: CreatePaywrapX402Config): PaywrapX402 => {
	const facilitator = resolveFacilitator(config);

	const resourceServer = new x402ResourceServer(facilitator).register(
		"eip155:*",
		new ExactEvmScheme(),
	);

	if (config.logger) {
		const logger = config.logger;
		resourceServer.onAfterSettle(async (ctx) => {
			if (!ctx.result.success) return;
			await safeLog(logger, {
				v: 1,
				kind: "payment_settled",
				timestamp: new Date().toISOString(),
				protocol: "x402",
				payer: ctx.result.payer as `0x${string}`,
				seller: config.payTo,
				amountUsdcMicro: String(ctx.requirements.amount ?? ""),
				route: "",
				latencyMs: 0,
				...(ctx.result.transaction ? { txHash: ctx.result.transaction } : {}),
				...(ctx.result.network ? { network: String(ctx.result.network) } : {}),
			});
		});
		resourceServer.onSettleFailure(async (ctx) => {
			await safeLog(logger, {
				v: 1,
				kind: "payment_failed",
				timestamp: new Date().toISOString(),
				protocol: "x402",
				stage: "settle",
				reason: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
			});
		});
	}

	return {
		resourceServer,
		facilitator,
		payTo: config.payTo,
		network: config.network,
		networkId: x402NetworkId(config.network),
		...(config.logger ? { logger: config.logger } : {}),
	};
};
