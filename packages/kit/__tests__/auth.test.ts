import { Session } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { VerifiedCredential } from "../src/auth/index.js";
import {
	buildChargeChallenge,
	buildProofChallenge,
	buildSessionChallenge,
	payerFromCredential,
} from "../src/auth/index.js";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../src/mpp/constants.js";
import { createPaywrapMpp } from "../src/mpp/mppx.js";
import { memoryStore } from "../src/mpp/stores.js";
import { channelIdFromLabel } from "../src/signing/index.js";
import { seedChannel } from "../src/testing/index.js";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const makeMppx = () =>
	createPaywrapMpp({
		walletPrivateKey: KNOWN_PK,
		publicBaseUrl: "https://svc.example.com",
		mppSecretKey: "a".repeat(64),
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
	}).mppx;

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

describe("auth.buildSessionChallenge", () => {
	it("returns a 402 descriptor with www-authenticate header", async () => {
		const mppx = makeMppx();
		const res = await buildSessionChallenge(mppx, {
			amount: "0.02",
			scope: "test:1",
			detail: "pay_up",
		});
		expect(res.status).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect((res.body as { detail: string }).detail).toBe("pay_up");
	});
});

describe("auth.buildChargeChallenge", () => {
	it("returns a 402 descriptor for a non-zero charge", async () => {
		const mppx = makeMppx();
		const res = await buildChargeChallenge(mppx, {
			amount: "0.02",
			scope: "test:charge:1",
			detail: "pay_up",
		});
		expect(res.status).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect((res.body as { detail: string }).detail).toBe("pay_up");
	});

	it("converts bigint amounts via .toString()", async () => {
		const mppx = makeMppx();
		const res = await buildChargeChallenge(mppx, {
			amount: 20000n,
			scope: "test:charge:2",
			detail: "pay_up",
		});
		expect(res.status).toBe(402);
	});

	it("passes meta through to the challenge", async () => {
		const mppx = makeMppx();
		const res = await buildChargeChallenge(mppx, {
			amount: "0.02",
			scope: "test:charge:3",
			detail: "pay_up",
			meta: { sku: "foo", pricingVersion: "1" },
		});
		expect(res.status).toBe(402);
		// mppx surfaces challenge on body — the meta is mppx-internal, but
		// verify the serialize round-tripped successfully.
		expect((res.body as { challenge: unknown }).challenge).toBeDefined();
	});

	it("produces a 500 envelope when challenge generation throws", async () => {
		// Fake mppx with a broken charge() — exercise the error path.
		const brokenMppx = {
			challenge: {
				tempo: {
					charge: async () => {
						throw new Error("boom");
					},
				},
			},
		};
		const res = await buildChargeChallenge(brokenMppx, {
			amount: "0.02",
			scope: "test:charge:err",
			detail: "pay_up",
		});
		expect(res.status).toBe(500);
		expect((res.body as { error: string }).error).toBe("challenge_generation_failed");
		expect((res.body as { reason: string }).reason).toBe("boom");
	});
});

describe("auth.buildProofChallenge", () => {
	it("issues a zero-amount charge for wallet-auth flows", async () => {
		const mppx = makeMppx();
		const res = await buildProofChallenge(mppx, {
			scope: "test:proof:1",
			detail: "auth_required",
		});
		expect(res.status).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
	});
});
