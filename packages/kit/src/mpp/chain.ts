import { tempo as tempoChainBase } from "viem/chains";
import { TEMPO_USDC } from "./constants.js";

/**
 * Tempo viem-chain object with `feeToken: USDC` wired in.
 *
 * The `feeToken` field tells Tempo's `prepareTransactionRequest` to deduct
 * gas from a non-native ERC-20 balance (USDC here) instead of the native
 * token. Without this, settle/close txs revert with "insufficient funds"
 * on wallets that only hold USDC — which is the product shape we want
 * (seller receives payment in USDC, holds no native).
 *
 * Gotcha we hit: viem's `prepareTransactionRequest` only reads `feeToken`
 * from the wallet client's `chain` object. Passing it per-call is silently
 * ignored. It MUST be on the chain.
 */
// biome-ignore lint/suspicious/noExplicitAny: feeToken is tempo-specific, not in base Chain type
export const tempoChain: any = { ...tempoChainBase, feeToken: TEMPO_USDC };
