import { tempo as tempoChainBase } from "viem/chains";
import { TEMPO_USDC } from "./constants.js";

/**
 * Tempo viem-chain object with `feeToken: USDC` wired in.
 *
 * Tells Tempo's `prepareTransactionRequest` to deduct gas from USDC instead of
 * native token — the product shape we want (seller holds only USDC, never
 * native). Gotcha: viem only reads `feeToken` from the wallet client's
 * `chain` object, not from per-call options.
 */
// biome-ignore lint/suspicious/noExplicitAny: feeToken is tempo-specific, not in base Chain type
export const tempoChain: any = { ...tempoChainBase, feeToken: TEMPO_USDC };
