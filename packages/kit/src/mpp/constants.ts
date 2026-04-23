import type { Hex } from "viem";

/**
 * Tempo mainnet contract addresses. Kept as a named export so we (and
 * consumers) never re-hardcode. Update in lockstep with Tempo's docs.
 */
export const TEMPO_USDC: Hex = "0x20C000000000000000000000b9537d11c60E8b50";
export const TEMPO_ESCROW: Hex = "0x33b901018174DDabE4841042ab76ba85D4e24f25";
export const TEMPO_CHAIN_ID = 4217;

/** USDC on Tempo is a TIP-20 with 6 decimals. */
export const USDC_DECIMALS = 6;
