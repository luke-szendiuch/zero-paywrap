/**
 * Charge-intent refund primitive.
 *
 * The kit deliberately does NOT auto-refund from the request path — that
 * would mask bugs and create abuse vectors (a buyer who can induce an
 * upstream 5xx gets free service). Refunds are a decision, not a default.
 *
 * This module is the "actually send the USDC back" primitive once the
 * decision has been made. Three usage shapes:
 *
 * 1. **Operator script** — read a `paywrap_refund_owed` log stream, call
 *    `refundCharge(mpp, event)` per row.
 * 2. **In-handler post-failure** — your handler decided this specific
 *    failure is refund-worthy and calls `refundCharge` before returning
 *    the error.
 * 3. **Scheduled job** — a worker drains a queue of `RefundOwedEvent`
 *    rows from a DB and refunds each one.
 *
 * Idempotency is the caller's responsibility. The helper sends one tx
 * per call; the caller dedupes (by `chargeHash`, by a refund-ID column,
 * by whatever already exists in their data layer). The kit does not
 * impose a refund-ledger schema.
 *
 * Funding: charge-intent settled means the buyer's USDC just landed in
 * the seller wallet, so the refund is funded by the very payment being
 * reversed. Gas is paid in USDC via `feeToken: USDC` on `tempoChain`,
 * out of the same balance — the seller absorbs the gas (~fractional
 * cents on Tempo) by default.
 *
 * Requires keyed mode (`PaywrapMppKeyed`). Address-only services have
 * no signer and can't send a refund tx; the type system enforces this.
 */

import { type Hex, encodeFunctionData } from "viem";
import { tempoChain } from "../mpp/chain.js";
import { TEMPO_USDC } from "../mpp/constants.js";
import type { PaywrapMppKeyed } from "../mpp/mppx.js";

const ERC20_TRANSFER_ABI = [
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
] as const;

export type RefundChargeInput = {
	/** Buyer's wallet — the destination of the refund. */
	payer: Hex;
	/** Refund amount in micro-USDC. Must be > 0. */
	amountUsdcMicro: bigint;
	/**
	 * Optional human-readable note. NOT written on-chain (ERC-20 has no memo
	 * field) — surfaced in the returned event and the structured log line so
	 * operators / dashboards / audit trails can correlate refunds with their
	 * triggering failures.
	 */
	note?: string;
	/**
	 * Optional charge identifier (tx hash, credential fingerprint) carried
	 * through to the log event so retries dedupe consistently with the
	 * original `paywrap_refund_owed` row.
	 */
	chargeHash?: string;
	/** Optional SKU echo — useful for grouping refunds by capability. */
	sku?: string;
};

export type RefundChargeOptions = {
	/** Override the USDC contract (test mode, alternate token). Defaults to `TEMPO_USDC`. */
	tokenContract?: Hex;
	/**
	 * Override the log sink. Defaults to `console.error`, matching the
	 * `paywrap_refund_owed` operator-grep convention so a single
	 * `grep paywrap_refund_(owed|sent)` pairs requests with refunds.
	 * Pass a custom sink for tests or to redirect to a structured pipeline.
	 * Errors thrown by the sink are swallowed.
	 */
	sink?: (line: string) => void;
};

export type RefundSentEvent = {
	msg: "paywrap_refund_sent";
	v: 1;
	timestamp: string;
	payer: Hex;
	amountUsdcMicro: string;
	txHash: Hex;
	tokenContract: Hex;
	note?: string;
	chargeHash?: string;
	sku?: string;
};

export type RefundChargeResult = {
	status: "sent";
	txHash: Hex;
	amountUsdcMicro: bigint;
	event: RefundSentEvent;
};

/**
 * Send a USDC refund to the original payer. Single responsibility — sign
 * + broadcast one ERC-20 `transfer` from the seller wallet, log a
 * `paywrap_refund_sent` event, return the tx hash.
 *
 * Caller is responsible for:
 * - **Idempotency.** Track which charges have been refunded; do not call
 *   `refundCharge` twice for the same `chargeHash`. The helper has no
 *   ledger.
 * - **Authorization.** Decide that a refund is owed before calling.
 * - **Note content.** Stored in logs only, not on-chain.
 *
 * Throws if:
 * - `amountUsdcMicro <= 0` (use the type system's `bigint`; we still guard).
 * - The wallet has insufficient USDC (viem rejects at simulation time).
 * - RPC is unreachable / signature rejected (caller should retry or queue).
 *
 * Requires keyed mode. Address-only `PaywrapMpp` is a compile error.
 */
export const refundCharge = async (
	mpp: Pick<PaywrapMppKeyed, "client" | "account" | "walletAddress">,
	input: RefundChargeInput,
	options?: RefundChargeOptions,
): Promise<RefundChargeResult> => {
	if (input.amountUsdcMicro <= 0n) {
		throw new Error(`refundCharge: amountUsdcMicro must be > 0 (got ${input.amountUsdcMicro})`);
	}
	const tokenContract = options?.tokenContract ?? TEMPO_USDC;

	const data = encodeFunctionData({
		abi: ERC20_TRANSFER_ABI,
		functionName: "transfer",
		args: [input.payer, input.amountUsdcMicro],
	});

	// Use sendTransaction (low-level) rather than writeContract so we don't
	// depend on viem's contract-write simulation path — keeps this Worker-safe
	// and avoids an extra eth_call before the send. tempoChain's feeToken: USDC
	// routes gas through the wallet's USDC balance.
	const txHash = await mpp.client.sendTransaction({
		account: mpp.account,
		chain: tempoChain,
		to: tokenContract,
		data,
		value: 0n,
	});

	const event: RefundSentEvent = {
		msg: "paywrap_refund_sent",
		v: 1,
		timestamp: new Date().toISOString(),
		payer: input.payer,
		amountUsdcMicro: input.amountUsdcMicro.toString(),
		txHash: txHash as Hex,
		tokenContract,
		...(input.note !== undefined && { note: input.note }),
		...(input.chargeHash !== undefined && { chargeHash: input.chargeHash }),
		...(input.sku !== undefined && { sku: input.sku }),
	};

	const sink = options?.sink ?? ((line) => console.error(line));
	try {
		sink(JSON.stringify(event));
	} catch {
		// observability must never break the hot path
	}

	return { status: "sent", txHash: event.txHash, amountUsdcMicro: input.amountUsdcMicro, event };
};
