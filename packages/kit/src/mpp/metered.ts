/**
 * Metered settlement helpers — server-side resilience for variable-amount
 * session billing.
 *
 * The flat-rate session pattern (one voucher = one charge) is handled by
 * `closeSessionOnChain` in `./settle.ts`. Metered services bill an actual
 * cost K computed from the upstream response, with K ≤ maxAmount the
 * buyer authorized. This module owns:
 *
 * - **Persistence:** `persistMeteredCloseVoucher` writes the buyer's
 *   close voucher onto the channel state (under `paywrapCloseVoucher`)
 *   so it survives RPC failures or Worker tear-downs.
 * - **Submission:** `closeMeteredChannelOnChain` submits an explicit
 *   close voucher; `closeMeteredChannelFromState` reads the persisted
 *   voucher and submits it (the seller-side reaper helper).
 *
 * Use this module from:
 * - The hono adapter's `mppMetered` middleware (close-voucher branch).
 * - Any seller-side cron / background worker that retries unfinalized
 *   metered channels.
 *
 * Do NOT use `closeSessionOnChain` for metered channels — it submits
 * `state.highestVoucher` which is the buyer's max-authorized voucher.
 */

import { Session } from "mppx/tempo";
import type { Hex } from "viem";
import { TEMPO_ESCROW } from "./constants.js";
import type { PaywrapMpp } from "./mppx.js";
import { type CloseSessionResult, isBenignCloseError } from "./settle.js";

/** Buyer-signed close voucher captured server-side for on-chain submission. */
export type CloseVoucher = {
	channelId: Hex;
	cumulativeAmount: bigint;
	signature: Hex;
};

/**
 * Channel-state augmentation paywrap writes alongside mppx's fields.
 * Keyed by `paywrapCloseVoucher` to avoid collision with mppx's reserved
 * field names. Read with the cast helper below; write via
 * `persistMeteredCloseVoucher`.
 */
export type PaywrapMeteredChannelMeta = {
	paywrapCloseVoucher?: CloseVoucher;
};

const readMeta = (state: unknown): PaywrapMeteredChannelMeta => {
	if (!state || typeof state !== "object") return {};
	const meta = state as PaywrapMeteredChannelMeta;
	return meta.paywrapCloseVoucher ? { paywrapCloseVoucher: meta.paywrapCloseVoucher } : {};
};

/**
 * Persist a buyer-signed close voucher onto the channel state. Called
 * by `mppMetered` BEFORE attempting on-chain submission so the voucher
 * survives RPC blips — a reaper hitting `closeMeteredChannelFromState`
 * later will pick up the persisted voucher and retry.
 *
 * Atomic via `channelStore.updateChannel`; preserves all mppx fields.
 */
export const persistMeteredCloseVoucher = async (
	mpp: Pick<PaywrapMpp, "channelStore">,
	channelId: Hex,
	voucher: CloseVoucher,
): Promise<void> => {
	await mpp.channelStore.updateChannel(channelId, (current) => {
		if (!current) return null;
		const next = { ...current, paywrapCloseVoucher: voucher } as typeof current;
		return next;
	});
};

const submitVoucher = async (
	mpp: Pick<PaywrapMpp, "channelStore" | "client" | "account">,
	channelId: Hex,
	voucher: CloseVoucher,
	escrow: Hex,
): Promise<CloseSessionResult> => {
	try {
		const txHash = await Session.Chain.closeOnChain(mpp.client, escrow, voucher, {
			account: mpp.account,
		});
		await mpp.channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			const settled =
				voucher.cumulativeAmount > current.settledOnChain
					? voucher.cumulativeAmount
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

/**
 * Submit an explicit metered close voucher on-chain. Use when you have
 * a voucher in hand without a fresh store read (e.g. retrying the same
 * voucher after a transient RPC failure).
 *
 * Idempotent — already-finalized channels return a skipped result via
 * the benign-error path. Sellers maintaining a background reaper should
 * prefer `closeMeteredChannelFromState` (reads persisted voucher
 * automatically).
 */
export const closeMeteredChannelOnChain = async (
	mpp: Pick<PaywrapMpp, "channelStore" | "client" | "account">,
	channelId: Hex,
	voucher: CloseVoucher,
	options?: { escrowContract?: Hex },
): Promise<CloseSessionResult> => {
	const state = await mpp.channelStore.getChannel(channelId);
	if (state?.finalized) return { status: "skipped", reason: "already-finalized" };
	return submitVoucher(mpp, channelId, voucher, options?.escrowContract ?? TEMPO_ESCROW);
};

/**
 * Reaper-style helper: read the persisted close voucher from channel
 * state and submit it on-chain. The "metered analog of
 * `closeSessionOnChain`" — same shape, but settles at the buyer's
 * actual amount instead of the max-authorized voucher.
 *
 * Returns `{status: 'skipped', reason: 'no-voucher'}` if no metered
 * close voucher was persisted (buyer's CLI never POSTed close, or
 * service is non-metered). In that case sellers can either:
 * - Wait — buyer can recover via `escrow.requestClose` (their gas, full refund)
 * - Fall through to `closeSessionOnChain` — settles at maxAmount
 *
 * The fall-through is NOT done automatically because it changes the
 * billing semantics; the seller must opt in by calling
 * `closeSessionOnChain` explicitly when they're certain the buyer has
 * gone silent and accept the max-amount settlement.
 */
export const closeMeteredChannelFromState = async (
	mpp: Pick<PaywrapMpp, "channelStore" | "client" | "account">,
	channelId: Hex,
	options?: { escrowContract?: Hex },
): Promise<CloseSessionResult> => {
	const state = await mpp.channelStore.getChannel(channelId);
	if (!state) return { status: "skipped", reason: "no-voucher" };
	if (state.finalized) return { status: "skipped", reason: "already-finalized" };
	const meta = readMeta(state);
	if (!meta.paywrapCloseVoucher) return { status: "skipped", reason: "no-voucher" };
	return submitVoucher(
		mpp,
		channelId,
		meta.paywrapCloseVoucher,
		options?.escrowContract ?? TEMPO_ESCROW,
	);
};
