import {
	type FacilitatorClient,
	type FacilitatorConfig,
	HTTPFacilitatorClient,
	x402ResourceServer,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { type X402Network, x402NetworkId } from "./constants.js";

export type CreatePaywrapX402Config = {
	/** Address that receives settled USDC. */
	payTo: `0x${string}`;
	/** Which Base chain to settle on. */
	network: X402Network;
	/**
	 * Facilitator config. Defaults to x402.org's public facilitator
	 * (`https://x402.org/facilitator`) which supports Base + Base Sepolia.
	 * For Coinbase CDP or another provider, pass `{ url, createAuthHeaders }`.
	 */
	facilitator?: FacilitatorConfig | FacilitatorClient;
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
export const createPaywrapX402 = (config: CreatePaywrapX402Config): PaywrapX402 => {
	const facilitator: FacilitatorClient = isFacilitatorClient(config.facilitator)
		? config.facilitator
		: new HTTPFacilitatorClient(config.facilitator);

	const resourceServer = new x402ResourceServer(facilitator).register(
		"eip155:*",
		new ExactEvmScheme(),
	);

	return {
		resourceServer,
		facilitator,
		payTo: config.payTo,
		network: config.network,
		networkId: x402NetworkId(config.network),
	};
};
