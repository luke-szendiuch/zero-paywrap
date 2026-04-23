import { Session } from "mppx/tempo";
import type { Hex } from "viem";
import { TEMPO_ESCROW } from "./constants.js";
import type { PaywrapMpp } from "./mppx.js";

/**
 * Error messages from `Session.Chain.closeOnChain` that indicate benign,
 * idempotent no-ops rather than real failures.
 *
 *   - `AmountNotIncreasing` / `ChannelFinalized` — escrow already recorded
 *     an equal-or-higher voucher, or the channel is already finalized.
 *   - `no voucher to settle` — voucher for this channel isn't in our local
 *     store yet (e.g. race with a freshly-opened channel that hasn't been
 *     observed).
 *   - `channel not found` — escrow has no record; likely a client opened a
 *     channel but never sent a voucher, and the channel has since expired.
 */
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
 * Atomically post a voucher AND finalize the channel in one transaction.
 *
 * Why close over settle: `settle` posts the voucher but leaves the channel
 * open (funds stay in escrow until a later finalize). `close` does both in
 * one tx. For one-voucher-per-channel services (the common case), `close`
 * cuts seller gas in half.
 *
 * Skips silently on the benign error conditions. Throws on genuine failures
 * (RPC down, signature rejection, insufficient gas) so the caller can decide
 * whether to retry.
 *
 * Seller pays gas. With `feeToken: USDC` on the chain object (see
 * `packages/kit/src/mpp/chain.ts`), gas comes from the wallet's USDC
 * balance — no native token needed.
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
