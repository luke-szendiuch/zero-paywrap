/**
 * Session-intent voucher rollback.
 *
 * In session intent, the buyer's deposit sits in escrow until the seller
 * calls `close(channelId, cumulativeAmount, signature)`. The contract
 * pays the seller `cumulativeAmount` and refunds `deposit - cumulativeAmount`
 * back to the payer in the same tx. So if a paid call fails after the
 * kit has already advanced `state.highestVoucher`, the seller can roll
 * the stored voucher back to the prior accepted value — the failed call's
 * amount stays in escrow and refunds naturally on the eventual close.
 *
 * No on-chain tx, no separate USDC transfer — just a write-back to the
 * channel store. The escrow contract handles the actual refund when the
 * seller closes at the rolled-back amount.
 *
 * Three usage shapes:
 *
 * 1. **Adapter-driven.** `mppGated({ intent: "session", refundOnFailure: true })`
 *    captures the prior voucher pre-verify and calls this on handler throw.
 * 2. **In-handler.** Your handler caught a recoverable upstream failure
 *    and decides not to bill — call this with the prior voucher you
 *    captured before the work began.
 * 3. **Reaper.** A background worker discovers a hung session whose last
 *    voucher should not be billed (audit trail, content-policy violation
 *    discovered after the fact) — rolls it back before close.
 *
 * Constraints enforced by this helper:
 * - Skip if the channel is finalized (close already submitted).
 * - Skip if the rollback target equals the current highest (idempotent).
 * - Skip if the target is **below `settledOnChain`** — submitting a close
 *   below what's already been settled mid-channel reverts on-chain
 *   (`AmountNotIncreasing`). This guards against rolling back through a
 *   prior `settleOnChain` call.
 *
 * Atomic via `channelStore.updateChannel`. Caller is responsible for
 * idempotency at the request level (don't call twice for the same failed
 * call) — this helper guards the channel-state invariants, not request
 * semantics.
 */

import type { Session } from "mppx/tempo";
import type { Hex } from "viem";
import type { PaywrapMpp } from "./mppx.js";

type SignedVoucher = NonNullable<Session.ChannelStore.State["highestVoucher"]>;

export type RollbackSessionVoucherResult =
	| { status: "rolled-back"; fromAmountUsdcMicro: bigint; toAmountUsdcMicro: bigint }
	| {
			status: "skipped";
			reason: "no-channel" | "already-finalized" | "no-change" | "below-settled";
			currentAmountUsdcMicro?: bigint;
			settledOnChainUsdcMicro?: bigint;
	  };

/**
 * Restore `highestVoucher` / `highestVoucherAmount` to a prior value
 * (or to `null` if rolling back the very first voucher of a channel).
 *
 * Pass `null` for `priorVoucher` to roll back a channel that had no
 * accepted voucher before this call (i.e. the failed call was the
 * channel's first paid request).
 */
export const rollbackSessionVoucher = async (
	channelStore: PaywrapMpp["channelStore"],
	channelId: Hex,
	priorVoucher: SignedVoucher | null,
): Promise<RollbackSessionVoucherResult> => {
	let result: RollbackSessionVoucherResult = {
		status: "skipped",
		reason: "no-channel",
	};
	await channelStore.updateChannel(channelId, (current) => {
		if (!current) {
			result = { status: "skipped", reason: "no-channel" };
			return null;
		}
		if (current.finalized) {
			result = {
				status: "skipped",
				reason: "already-finalized",
				currentAmountUsdcMicro: current.highestVoucherAmount,
			};
			return current;
		}
		const priorAmount = priorVoucher?.cumulativeAmount ?? 0n;
		if (current.highestVoucherAmount === priorAmount) {
			result = {
				status: "skipped",
				reason: "no-change",
				currentAmountUsdcMicro: current.highestVoucherAmount,
			};
			return current;
		}
		// On-chain `settle()` and `close()` revert on cumulativeAmount <
		// the contract's stored settled value. If the seller has called
		// `settleOnChain` mid-channel, our local `settledOnChain` reflects
		// that — rolling back below it would brick the channel.
		if (priorAmount < current.settledOnChain) {
			result = {
				status: "skipped",
				reason: "below-settled",
				currentAmountUsdcMicro: current.highestVoucherAmount,
				settledOnChainUsdcMicro: current.settledOnChain,
			};
			return current;
		}
		result = {
			status: "rolled-back",
			fromAmountUsdcMicro: current.highestVoucherAmount,
			toAmountUsdcMicro: priorAmount,
		};
		return {
			...current,
			highestVoucher: priorVoucher,
			highestVoucherAmount: priorAmount,
		};
	});
	return result;
};
