/**
 * x402 settles on Base / Base Sepolia in USDC. Networks use CAIP-2
 * (`eip155:<chainId>`) per the x402 spec.
 *
 * Mainnet/sepolia USDC contracts are pinned to the Coinbase-issued addresses
 * from circle.com/usdc-multichain — same source @x402/evm uses.
 */
export const BASE_NETWORK = "eip155:8453" as const;
export const BASE_SEPOLIA_NETWORK = "eip155:84532" as const;

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export const USDC_DECIMALS = 6;

export type X402Network = "base" | "base-sepolia";

export type X402NetworkId = typeof BASE_NETWORK | typeof BASE_SEPOLIA_NETWORK;

export const x402NetworkId = (network: X402Network): X402NetworkId =>
	network === "base" ? BASE_NETWORK : BASE_SEPOLIA_NETWORK;

export const x402UsdcAsset = (network: X402Network): string =>
	network === "base" ? BASE_USDC : BASE_SEPOLIA_USDC;
