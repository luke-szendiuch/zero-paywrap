import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW, TEMPO_USDC } from "../../src/mpp/constants.js";
import { rollbackSessionVoucher } from "../../src/mpp/rollback.js";
import { memoryStore } from "../../src/mpp/stores.js";
import { channelIdFromLabel } from "../../src/signing/index.js";
import { seedChannel } from "../../src/testing/index.js";

const setup = async (label: string) => {
	const store = memoryStore();
	const channelStore = Session.ChannelStore.fromStore(store);
	const payer = privateKeyToAccount(generatePrivateKey());
	const payee = privateKeyToAccount(generatePrivateKey());
	const channelId = channelIdFromLabel(label);
	await seedChannel({
		channelStore,
		channelId,
		payer: payer.address,
		payee: payee.address,
		escrowContract: TEMPO_ESCROW,
		chainId: TEMPO_CHAIN_ID,
		deposit: 1_000_000n,
	});
	return { channelStore, channelId, payer, payee };
};

const voucher = (channelId: `0x${string}`, amount: bigint) => ({
	channelId,
	cumulativeAmount: amount,
	signature: "0x00" as `0x${string}`,
});

describe("mpp.rollback.rollbackSessionVoucher", () => {
	it("rolls back highestVoucher to a prior signed voucher", async () => {
		const { channelStore, channelId } = await setup("rollback-happy");
		const prior = voucher(channelId, 1_000n);
		const advanced = voucher(channelId, 1_500n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return { ...current, highestVoucher: advanced, highestVoucherAmount: 1_500n };
		});

		const result = await rollbackSessionVoucher(channelStore, channelId, prior);

		expect(result).toEqual({
			status: "rolled-back",
			fromAmountUsdcMicro: 1_500n,
			toAmountUsdcMicro: 1_000n,
		});
		const after = await channelStore.getChannel(channelId);
		expect(after?.highestVoucherAmount).toBe(1_000n);
		expect(after?.highestVoucher).toEqual(prior);
	});

	it("rolls back to null when the failed call was the channel's first voucher", async () => {
		const { channelStore, channelId } = await setup("rollback-first");
		const advanced = voucher(channelId, 500n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return { ...current, highestVoucher: advanced, highestVoucherAmount: 500n };
		});

		const result = await rollbackSessionVoucher(channelStore, channelId, null);

		expect(result).toEqual({
			status: "rolled-back",
			fromAmountUsdcMicro: 500n,
			toAmountUsdcMicro: 0n,
		});
		const after = await channelStore.getChannel(channelId);
		expect(after?.highestVoucher).toBeNull();
		expect(after?.highestVoucherAmount).toBe(0n);
	});

	it("returns no-channel when channelId is unknown", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const channelId = channelIdFromLabel("missing");

		const result = await rollbackSessionVoucher(channelStore, channelId, null);

		expect(result).toEqual({ status: "skipped", reason: "no-channel" });
	});

	it("skips finalized channels — close already submitted", async () => {
		const { channelStore, channelId } = await setup("rollback-final");
		const advanced = voucher(channelId, 500n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return {
				...current,
				highestVoucher: advanced,
				highestVoucherAmount: 500n,
				finalized: true,
			};
		});

		const result = await rollbackSessionVoucher(channelStore, channelId, voucher(channelId, 100n));

		expect(result).toMatchObject({
			status: "skipped",
			reason: "already-finalized",
			currentAmountUsdcMicro: 500n,
		});
		const after = await channelStore.getChannel(channelId);
		expect(after?.highestVoucherAmount).toBe(500n); // unchanged
	});

	it("is idempotent — already-at-target returns no-change without writing", async () => {
		const { channelStore, channelId } = await setup("rollback-idem");
		const at = voucher(channelId, 1_000n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return { ...current, highestVoucher: at, highestVoucherAmount: 1_000n };
		});

		const result = await rollbackSessionVoucher(channelStore, channelId, at);

		expect(result).toMatchObject({ status: "skipped", reason: "no-change" });
	});

	it("refuses to roll back below settledOnChain — would brick the on-chain close", async () => {
		const { channelStore, channelId } = await setup("rollback-settled");
		const advanced = voucher(channelId, 2_000n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return {
				...current,
				highestVoucher: advanced,
				highestVoucherAmount: 2_000n,
				settledOnChain: 1_500n, // mid-channel settle already happened
			};
		});

		const result = await rollbackSessionVoucher(channelStore, channelId, voucher(channelId, 800n));

		expect(result).toMatchObject({
			status: "skipped",
			reason: "below-settled",
			currentAmountUsdcMicro: 2_000n,
			settledOnChainUsdcMicro: 1_500n,
		});
		const after = await channelStore.getChannel(channelId);
		expect(after?.highestVoucherAmount).toBe(2_000n); // unchanged
	});

	it("allows rollback to exactly settledOnChain — the on-chain floor", async () => {
		const { channelStore, channelId } = await setup("rollback-floor");
		const advanced = voucher(channelId, 2_000n);
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return {
				...current,
				highestVoucher: advanced,
				highestVoucherAmount: 2_000n,
				settledOnChain: 1_500n,
			};
		});

		const result = await rollbackSessionVoucher(
			channelStore,
			channelId,
			voucher(channelId, 1_500n),
		);

		expect(result).toMatchObject({
			status: "rolled-back",
			fromAmountUsdcMicro: 2_000n,
			toAmountUsdcMicro: 1_500n,
		});
	});

	it("preserves all other channel state fields verbatim", async () => {
		const { channelStore, channelId } = await setup("rollback-preserve");
		await channelStore.updateChannel(channelId, (current) => {
			if (!current) return null;
			return {
				...current,
				highestVoucher: voucher(channelId, 800n),
				highestVoucherAmount: 800n,
				spent: 800n,
				units: 4,
			};
		});

		await rollbackSessionVoucher(channelStore, channelId, voucher(channelId, 400n));

		const after = await channelStore.getChannel(channelId);
		expect(after?.spent).toBe(800n);
		expect(after?.units).toBe(4);
		expect(after?.token).toBe(TEMPO_USDC);
		expect(after?.deposit).toBe(1_000_000n);
		expect(after?.finalized).toBe(false);
	});
});
