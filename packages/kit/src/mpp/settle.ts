import { Session } from "mppx/tempo";
import type { Hex } from "viem";
import { TEMPO_ESCROW } from "./constants.js";
import type { PaywrapMpp } from "./mppx.js";

// Error messages from `Session.Chain.closeOnChain` that indicate idempotent
// no-ops rather than real failures (already settled, channel gone, etc).
const BENIGN_CLOSE_ERRORS = [
	"AmountNotIncreasing",
	"ChannelFinalized",
	"already finalized",
	"no voucher to settle",
	"channel not found",
] as const;

export const isBenignCloseError = (err: unknown): boolean => {
	const msg = err instanceof Error ? err.message : String(err);
	return BENIGN_CLOSE_ERRORS.some((s) => msg.includes(s));
};

export type CloseSessionResult =
	| { status: "closed"; txHash: Hex }
	| {
			status: "skipped";
			reason: "no-voucher" | "already-finalized" | "benign-error";
			message?: string;
	  };

/**
 * Post the highest voucher AND finalize the channel in a single tx. For
 * one-voucher-per-channel services this halves seller gas vs. `settle` +
 * later `finalize`. Benign errors (already settled, channel gone) return a
 * `skipped` result; genuine failures (RPC down, signature rejected) throw.
 *
 * Seller pays gas; with `feeToken: USDC` on `tempoChain` (see `./chain.ts`)
 * gas comes from the wallet's USDC, no native needed.
 */
export const closeSessionOnChain = async (
	mpp: Pick<PaywrapMpp, "channelStore" | "client" | "account">,
	channelId: Hex,
	options?: { escrowContract?: Hex },
): Promise<CloseSessionResult> => {
	const state = await mpp.channelStore.getChannel(channelId);
	if (!state?.highestVoucher) {
		return { status: "skipped", reason: "no-voucher" };
	}
	if (state.finalized) {
		return { status: "skipped", reason: "already-finalized" };
	}
	const escrow = options?.escrowContract ?? TEMPO_ESCROW;
	try {
		const txHash = await Session.Chain.closeOnChain(mpp.client, escrow, state.highestVoucher, {
			account: mpp.account,
		});
		await mpp.channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			const voucherAmount = state.highestVoucher?.cumulativeAmount;
			const settled =
				voucherAmount !== undefined && voucherAmount > current.settledOnChain
					? voucherAmount
					: current.settledOnChain;
			return { ...current, finalized: true, settledOnChain: settled };
		});
		return { status: "closed", txHash: txHash as Hex };
	} catch (err) {
		if (isBenignCloseError(err)) {
			return {
				status: "skipped",
				reason: "benign-error",
				message: err instanceof Error ? err.message : String(err),
			};
		}
		throw err;
	}
};
