import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../../src/mpp/constants.js";
import {
	type CloseVoucher,
	closeMeteredChannelFromState,
	persistMeteredCloseVoucher,
} from "../../src/mpp/metered.js";
import { memoryStore } from "../../src/mpp/stores.js";
import { channelIdFromLabel } from "../../src/signing/index.js";
import { seedChannel } from "../../src/testing/index.js";

const seedFor = async (label: string) => {
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
		deposit: 200_000n,
	});
	return { channelStore, channelId };
};

describe("mpp.metered.persistMeteredCloseVoucher", () => {
	it("writes paywrapCloseVoucher onto channel state without losing mppx fields", async () => {
		const { channelStore, channelId } = await seedFor("persist-basic");
		const before = await channelStore.getChannel(channelId);
		const voucher: CloseVoucher = {
			channelId,
			cumulativeAmount: 12_345n,
			signature: `0x${"a".repeat(130)}` as `0x${string}`,
		};
		await persistMeteredCloseVoucher({ channelStore }, channelId, voucher);
		const after = (await channelStore.getChannel(channelId)) as
			| (NonNullable<typeof before> & { paywrapCloseVoucher?: CloseVoucher })
			| null;
		expect(after?.paywrapCloseVoucher).toEqual(voucher);
		// mppx fields preserved
		expect(after?.deposit).toBe(before?.deposit);
		expect(after?.payer).toBe(before?.payer);
	});

	it("noops if the channel doesn't exist", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const channelId = channelIdFromLabel("missing");
		await expect(
			persistMeteredCloseVoucher({ channelStore }, channelId, {
				channelId,
				cumulativeAmount: 1n,
				signature: `0x${"b".repeat(130)}` as `0x${string}`,
			}),
		).resolves.toBeUndefined();
		expect(await channelStore.getChannel(channelId)).toBeNull();
	});
});

describe("mpp.metered.closeMeteredChannelFromState", () => {
	it("returns no-voucher when no paywrapCloseVoucher is persisted", async () => {
		const { channelStore, channelId } = await seedFor("from-state-empty");
		const result = await closeMeteredChannelFromState(
			{
				channelStore,
				// biome-ignore lint/suspicious/noExplicitAny: client/account unused on no-voucher branch
				client: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: same
				account: {} as any,
			},
			channelId,
		);
		expect(result).toEqual({ status: "skipped", reason: "no-voucher" });
	});

	it("returns already-finalized when channel.finalized is true", async () => {
		const { channelStore, channelId } = await seedFor("from-state-final");
		// Persist a voucher AND finalize the channel — finalized check wins.
		await persistMeteredCloseVoucher({ channelStore }, channelId, {
			channelId,
			cumulativeAmount: 1n,
			signature: `0x${"c".repeat(130)}` as `0x${string}`,
		});
		await channelStore.updateChannel(channelId, (c) => (c ? { ...c, finalized: true } : null));
		const result = await closeMeteredChannelFromState(
			{
				channelStore,
				// biome-ignore lint/suspicious/noExplicitAny: client/account unused on already-finalized branch
				client: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: same
				account: {} as any,
			},
			channelId,
		);
		expect(result).toEqual({ status: "skipped", reason: "already-finalized" });
	});

	it("returns no-voucher when channel doesn't exist", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const result = await closeMeteredChannelFromState(
			{
				channelStore,
				// biome-ignore lint/suspicious/noExplicitAny: client/account unused on no-voucher branch
				client: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: same
				account: {} as any,
			},
			channelIdFromLabel("nope"),
		);
		expect(result).toEqual({ status: "skipped", reason: "no-voucher" });
	});
});
