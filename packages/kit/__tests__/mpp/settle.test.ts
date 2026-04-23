import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../../src/mpp/constants.js";
import { closeSessionOnChain, isBenignCloseError } from "../../src/mpp/settle.js";
import { memoryStore } from "../../src/mpp/stores.js";
import { channelIdFromLabel } from "../../src/signing/index.js";
import { seedChannel } from "../../src/testing/index.js";

describe("mpp.settle.isBenignCloseError", () => {
	it.each([
		"AmountNotIncreasing",
		"ChannelFinalized",
		"already finalized",
		"no voucher to settle",
		"channel not found",
	])("matches '%s'", (needle) => {
		expect(isBenignCloseError(new Error(`wrapped: ${needle} here`))).toBe(true);
	});

	it("matches on bare strings passed as err", () => {
		expect(isBenignCloseError("channel not found in state")).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isBenignCloseError(new Error("RPC timeout"))).toBe(false);
		expect(isBenignCloseError(new Error("signature rejected"))).toBe(false);
		expect(isBenignCloseError("boom")).toBe(false);
	});
});

describe("mpp.settle.closeSessionOnChain", () => {
	it("returns {status:'skipped', reason:'no-voucher'} when the channel has no voucher", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const payer = privateKeyToAccount(generatePrivateKey());
		const payee = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("no-voucher");
		await seedChannel({
			channelStore,
			channelId,
			payer: payer.address,
			payee: payee.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			deposit: 1n,
		});

		// The client/account are not consulted when there is no voucher — we
		// can pass stand-ins.
		const result = await closeSessionOnChain(
			{
				channelStore,
				// biome-ignore lint/suspicious/noExplicitAny: wallet client isn't used on the no-voucher branch
				client: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: account isn't used on the no-voucher branch
				account: {} as any,
			},
			channelId,
		);

		expect(result).toEqual({ status: "skipped", reason: "no-voucher" });
	});

	it("returns {status:'skipped', reason:'no-voucher'} when the channel does not exist", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const result = await closeSessionOnChain(
			{
				channelStore,
				// biome-ignore lint/suspicious/noExplicitAny: wallet client isn't used on the no-voucher branch
				client: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: account isn't used on the no-voucher branch
				account: {} as any,
			},
			channelIdFromLabel("never-existed"),
		);
		expect(result).toEqual({ status: "skipped", reason: "no-voucher" });
	});
});
