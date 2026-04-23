import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { VerifiedCredential } from "../src/auth/index.js";
import { payerFromCredential } from "../src/auth/index.js";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../src/mpp/constants.js";
import { memoryStore } from "../src/mpp/stores.js";
import { channelIdFromLabel, seedChannel } from "../src/signing/index.js";

// `VerifiedCredential` is the shape mppx returns from `verifyCredential()`.
// For unit purposes we build a minimally-compatible object — the function
// under test only reads `payload.channelId` and `source`.
const fakeCredential = (payload: Record<string, unknown>, source?: string): VerifiedCredential =>
	({
		challenge: {} as unknown,
		payload,
		...(source !== undefined ? { source } : {}),
	}) as unknown as VerifiedCredential;

describe("auth.payerFromCredential", () => {
	it("returns the seeded payer for a voucher credential (channelId path)", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const payer = privateKeyToAccount(generatePrivateKey());
		const payee = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("auth-voucher");
		await seedChannel({
			channelStore,
			channelId,
			payer: payer.address,
			payee: payee.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			deposit: 1n,
		});

		const addr = await payerFromCredential(channelStore, fakeCredential({ channelId }));
		expect(addr).toBe(payer.address.toLowerCase());
	});

	it("returns null when the voucher's channelId isn't in the store", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const addr = await payerFromCredential(
			channelStore,
			fakeCredential({ channelId: channelIdFromLabel("missing") }),
		);
		expect(addr).toBeNull();
	});

	it("extracts the address from a proof credential's did:pkh source", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const address = "0xABCDEF0123456789aBCdEf0123456789AbCdEf01";
		const addr = await payerFromCredential(
			channelStore,
			fakeCredential({ type: "proof" }, `did:pkh:eip155:4217:${address}`),
		);
		expect(addr).toBe(address.toLowerCase());
	});

	it("returns null for a malformed did:pkh source", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const cases = [
			"did:pkh:eip155:not-a-chain:0x0000000000000000000000000000000000000001",
			"did:pkh:eip155:1:not-an-address",
			"not-a-did",
			"did:pkh:bip122:abc:def",
		];
		for (const src of cases) {
			const addr = await payerFromCredential(channelStore, fakeCredential({}, src));
			expect(addr).toBeNull();
		}
	});

	it("returns null when neither channelId nor a string source is present", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const addr = await payerFromCredential(channelStore, fakeCredential({}));
		expect(addr).toBeNull();
	});
});
