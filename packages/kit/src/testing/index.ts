import type { Session } from "mppx/tempo";
import type { Address, Hex } from "viem";
import { TEMPO_USDC } from "../mpp/constants.js";

export type SeedChannelParams = {
	channelStore: ReturnType<typeof Session.ChannelStore.fromStore>;
	channelId: Hex;
	payer: Address;
	payee: Address;
	escrowContract: Address;
	chainId: number;
	deposit: bigint;
	/** Token address in escrow; defaults to USDC on Tempo. */
	token?: Address;
};

/**
 * Seed a ChannelStore with a fake-already-open channel. Tests only —
 * production opens channels via an on-chain `open` tx.
 *
 * mppx's voucher handler treats the cached state as authoritative for
 * `channelStateTtl` ms. Pair this with `createPaywrapMpp({ ..., channelStateTtl:
 * Number.POSITIVE_INFINITY })` so tests never reach for the RPC.
 */
export const seedChannel = async (params: SeedChannelParams): Promise<void> => {
	await params.channelStore.updateChannel(params.channelId, () => ({
		channelId: params.channelId,
		chainId: params.chainId,
		escrowContract: params.escrowContract,
		closeRequestedAt: 0n,
		createdAt: new Date().toISOString(),
		deposit: params.deposit,
		finalized: false,
		highestVoucher: null,
		highestVoucherAmount: 0n,
		payee: params.payee,
		payer: params.payer,
		settledOnChain: 0n,
		spent: 0n,
		token: params.token ?? TEMPO_USDC,
		units: 0,
		authorizedSigner: params.payer,
	}));
};
