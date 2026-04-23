import { Credential } from "mppx";
import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW, TEMPO_USDC } from "../src/mpp/constants.js";
import { memoryStore } from "../src/mpp/stores.js";
import {
	buildVoucherCredential,
	channelIdFromLabel,
	seedChannel,
	signVoucher,
} from "../src/signing/index.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const SECRET_KEY = "a".repeat(64);

describe("signing.channelIdFromLabel", () => {
	it("is deterministic for the same label", () => {
		expect(channelIdFromLabel("abc")).toBe(channelIdFromLabel("abc"));
	});

	it("produces a 32-byte (0x + 64 hex) id", () => {
		const id = channelIdFromLabel("test-channel");
		expect(id).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it("produces distinct ids for distinct labels", () => {
		expect(channelIdFromLabel("a")).not.toBe(channelIdFromLabel("b"));
	});
});

describe("signing.signVoucher", () => {
	it("returns a 0x-hex signature of 65 bytes (130 hex chars)", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const sig = await signVoucher({
			payer,
			channelId: channelIdFromLabel("sig-test"),
			cumulativeAmount: 1_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
		});
		expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
	});
});

describe("signing.buildVoucherCredential", () => {
	it("produces a string that deserializes back into a Credential with matching payload", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("build-voucher");
		const serialized = await buildVoucherCredential({
			payer,
			channelId,
			cumulativeAmount: 2_500n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: RECIPIENT,
			realm: "api.example.com",
			secretKey: SECRET_KEY,
			scope: "my-scope:1",
		});

		expect(typeof serialized).toBe("string");
		expect(serialized.startsWith("Payment ")).toBe(true);

		const credential = Credential.deserialize<{
			action: string;
			channelId: string;
			cumulativeAmount: string;
			signature: string;
		}>(serialized);
		expect(credential.payload.action).toBe("voucher");
		expect(credential.payload.channelId).toBe(channelId);
		expect(credential.payload.cumulativeAmount).toBe("2500");
		expect(credential.payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
		expect(credential.challenge.realm).toBe("api.example.com");
		expect(credential.challenge.method).toBe("tempo");
		expect(credential.challenge.intent).toBe("session");
		// scope ends up under the reserved `_mppx_scope` opaque key
		expect(credential.challenge.opaque?._mppx_scope).toBe("my-scope:1");
	});

	it("merges extra meta into opaque alongside the scope", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const serialized = await buildVoucherCredential({
			payer,
			channelId: channelIdFromLabel("with-meta"),
			cumulativeAmount: 1n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: RECIPIENT,
			realm: "api.example.com",
			secretKey: SECRET_KEY,
			scope: "scoped",
			meta: { route: "/v1/provision", sku: "alpha" },
		});

		const credential = Credential.deserialize(serialized);
		expect(credential.challenge.opaque?.route).toBe("/v1/provision");
		expect(credential.challenge.opaque?.sku).toBe("alpha");
		expect(credential.challenge.opaque?._mppx_scope).toBe("scoped");
	});
});

describe("signing.seedChannel", () => {
	it("writes channel state readable through Session.ChannelStore", async () => {
		const store = memoryStore();
		const channelStore = Session.ChannelStore.fromStore(store);
		const payer = privateKeyToAccount(generatePrivateKey());
		const payee = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("seed");

		await seedChannel({
			channelStore,
			channelId,
			payer: payer.address,
			payee: payee.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			deposit: 10_000n,
		});

		const state = await channelStore.getChannel(channelId);
		expect(state).not.toBeNull();
		expect(state?.channelId).toBe(channelId);
		expect(state?.payer.toLowerCase()).toBe(payer.address.toLowerCase());
		expect(state?.payee.toLowerCase()).toBe(payee.address.toLowerCase());
		expect(state?.deposit).toBe(10_000n);
		expect(state?.chainId).toBe(TEMPO_CHAIN_ID);
		expect(state?.escrowContract).toBe(TEMPO_ESCROW);
		expect(state?.token).toBe(TEMPO_USDC);
		expect(state?.highestVoucher).toBeNull();
		expect(state?.finalized).toBe(false);
		expect(state?.authorizedSigner.toLowerCase()).toBe(payer.address.toLowerCase());
	});
});
