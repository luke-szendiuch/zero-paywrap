import { Credential } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { VERIFIED } from "../../src/auth/index.js";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../../src/mpp/constants.js";
import { createPaywrapMpp } from "../../src/mpp/mppx.js";
import { memoryStore } from "../../src/mpp/stores.js";
import { assertVoucherAdvances, verifyWithScope } from "../../src/mpp/verify.js";
import { buildVoucherCredential, channelIdFromLabel } from "../../src/signing/index.js";
import { seedChannel } from "../../src/testing/index.js";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const SECRET_KEY = "a".repeat(64);
const REALM = "svc.example.com";

describe("mpp.verify.verifyWithScope (end-to-end)", () => {
	const setup = async (opts: { scope: string }) => {
		const store = memoryStore();
		const { mppx, channelStore, account } = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: `https://${REALM}`,
			mppSecretKey: SECRET_KEY,
			tempoRpcUrl: "https://rpc.example/tempo",
			store,
			channelStateTtl: Number.POSITIVE_INFINITY,
		});
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("verify-e2e");
		await seedChannel({
			channelStore,
			channelId,
			payer: payer.address,
			payee: account.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			deposit: 10_000n,
		});
		const header = await buildVoucherCredential({
			payer,
			channelId,
			cumulativeAmount: 1_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: opts.scope,
		});
		return { mppx, credential: Credential.deserialize(header) };
	};

	it("accepts a voucher credential whose scope matches and returns a branded VerifiedCredential", async () => {
		const { mppx, credential } = await setup({ scope: "scopeA:1" });
		const verified = await verifyWithScope(mppx, credential, "scopeA:1");
		expect(verified[VERIFIED]).toBe(true);
		expect(verified.credential).toBeDefined();
		expect(verified.credential.payload).toBeDefined();
	});

	it("rejects a voucher credential signed for a different scope", async () => {
		const { mppx, credential } = await setup({ scope: "scopeA:1" });
		await expect(verifyWithScope(mppx, credential, "scopeB:1")).rejects.toThrow();
	});
});

describe("mpp.verify.assertVoucherAdvances", () => {
	it("passes when the voucher advances by exactly minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 150n, 50n)).not.toThrow();
	});

	it("passes when the voucher advances by more than minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 200n, 50n)).not.toThrow();
	});

	it("throws voucher_non_advancing when delta is less than minDelta", () => {
		expect(() => assertVoucherAdvances(100n, 120n, 50n)).toThrow("voucher_non_advancing");
	});

	it("throws voucher_non_advancing when the voucher matches current (replay)", () => {
		expect(() => assertVoucherAdvances(100n, 100n, 1n)).toThrow("voucher_non_advancing");
	});

	it("throws voucher_non_advancing when the voucher REGRESSES below current", () => {
		expect(() => assertVoucherAdvances(100n, 50n, 1n)).toThrow("voucher_non_advancing");
	});

	it("passes when both sides are zero and minDelta is zero (degenerate but valid)", () => {
		expect(() => assertVoucherAdvances(0n, 0n, 0n)).not.toThrow();
	});
});
