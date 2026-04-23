import { Credential } from "mppx";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { extractCredential } from "../src/auth/index.js";
import { createPaywrapMpp } from "../src/mpp/mppx.js";
import { memoryStore } from "../src/mpp/stores.js";
import { verifyWithScope } from "../src/mpp/verify.js";
import { buildChargeCredential } from "../src/signing/index.js";
import { stubVerifyCredential } from "../src/testing/index.js";

const SELLER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REALM = "svc.example.com";
const SECRET_KEY = "a".repeat(64);

const makeMpp = () =>
	createPaywrapMpp({
		walletPrivateKey: SELLER_PK,
		publicBaseUrl: `https://${REALM}`,
		mppSecretKey: SECRET_KEY,
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
	});

describe("testing.stubVerifyCredential", () => {
	it("replaces verifyCredential and restores it cleanly", () => {
		const mpp = makeMpp();
		const original = mpp.mppx.verifyCredential;
		expect(typeof original).toBe("function");
		const { restore } = stubVerifyCredential(mpp.mppx);
		expect(mpp.mppx.verifyCredential).not.toBe(original);
		restore();
		expect(mpp.mppx.verifyCredential).toBe(original);
	});

	it("stubbed verify + buildChargeCredential → verifyWithScope succeeds for a paid charge", async () => {
		const mpp = makeMpp();
		const buyer = privateKeyToAccount(
			"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		);
		const { restore } = stubVerifyCredential(mpp.mppx);
		try {
			const authz = await buildChargeCredential({
				payer: buyer,
				recipient: mpp.account.address,
				amountMicro: 20_000n,
				realm: REALM,
				secretKey: SECRET_KEY,
				scope: "test:1",
			});
			const parsed = extractCredential(authz);
			expect(parsed).not.toBeNull();
			if (!parsed) throw new Error("unreachable");
			const verified = await verifyWithScope(mpp.mppx, parsed, "test:1");
			expect(verified).toBeDefined();
		} finally {
			restore();
		}
	});

	it("stub enforces scope mismatch (still rejects mismatched scope just like real verify)", async () => {
		const mpp = makeMpp();
		const buyer = privateKeyToAccount(
			"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		);
		const { restore } = stubVerifyCredential(mpp.mppx);
		try {
			const authz = await buildChargeCredential({
				payer: buyer,
				recipient: mpp.account.address,
				amountMicro: 20_000n,
				realm: REALM,
				secretKey: SECRET_KEY,
				scope: "scopeA:1",
			});
			const parsed = Credential.deserialize(authz);
			await expect(verifyWithScope(mpp.mppx, parsed, "scopeB:1")).rejects.toThrow(/scope mismatch/);
		} finally {
			restore();
		}
	});

	it("restore() after use returns real verify (which rejects the fake cred against no chain)", async () => {
		const mpp = makeMpp();
		const buyer = privateKeyToAccount(
			"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		);
		const { restore } = stubVerifyCredential(mpp.mppx);
		restore();
		const authz = await buildChargeCredential({
			payer: buyer,
			recipient: mpp.account.address,
			amountMicro: 20_000n,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "restored:1",
		});
		const parsed = Credential.deserialize(authz);
		// Real verify: zero-amount expects proof, non-zero expects hash/tx.
		// Our proof-shaped cred for non-zero fails the real path.
		await expect(verifyWithScope(mpp.mppx, parsed, "restored:1")).rejects.toThrow();
	});
});
