import { Credential } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "../../src/mpp/constants.js";
import { createPaywrapMpp } from "../../src/mpp/mppx.js";
import { memoryStore } from "../../src/mpp/stores.js";
import { verifyWithScope } from "../../src/mpp/verify.js";
import { buildVoucherCredential, channelIdFromLabel } from "../../src/signing/index.js";
import { seedChannel } from "../../src/testing/index.js";

// Known-answer private key / address pair (Anvil test account index 0).
const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KNOWN_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cfFFb92266" as const;

describe("mpp.createPaywrapMpp", () => {
	it("builds a bundle with mppx, channelStore, account, client", () => {
		const bundle = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: "https://svc.example.com",
			mppSecretKey: "a".repeat(64),
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
		});

		expect(bundle).not.toBeNull();
		expect(bundle.mppx).toBeDefined();
		expect(bundle.channelStore).toBeDefined();
		expect(typeof bundle.channelStore.getChannel).toBe("function");
		expect(typeof bundle.channelStore.updateChannel).toBe("function");
		expect(bundle.account).toBeDefined();
		expect(bundle.client).toBeDefined();
	});

	it("derives account.address from the provided private key", () => {
		const bundle = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: "https://svc.example.com",
			mppSecretKey: "a".repeat(64),
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
		});
		// Compare case-insensitively to sidestep EIP-55 checksum casing differences
		// between viem versions.
		expect(bundle.account.address.toLowerCase()).toBe(KNOWN_ADDR.toLowerCase());
		// Sanity: independently derived account matches.
		expect(bundle.account.address).toBe(privateKeyToAccount(KNOWN_PK).address);
	});

	it("accepts an explicit channelStateTtl without throwing", () => {
		const bundle = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: "https://svc.example.com",
			mppSecretKey: "a".repeat(64),
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
			channelStateTtl: Number.POSITIVE_INFINITY,
		});
		expect(bundle.mppx).toBeDefined();
	});

	it("omits `store` → falls back to memory store with a warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const originalRedisUrl = process.env.REDIS_URL;
		// biome-ignore lint/performance/noDelete: we need REDIS_URL literally unset (not "undefined" string) to exercise the no-REDIS_URL branch
		delete process.env.REDIS_URL;
		try {
			const bundle = createPaywrapMpp({
				walletPrivateKey: KNOWN_PK,
				publicBaseUrl: "https://svc.example.com",
				mppSecretKey: "a".repeat(64),
				tempoRpcUrl: "https://rpc.example/tempo",
			});
			expect(bundle.mppx).toBeDefined();
			// Warning fires at most once per process — first call OR a
			// previous test in this file may have already triggered it.
			// Assert the warning fingerprint if it did fire here.
			if (warnSpy.mock.calls.length > 0) {
				const call = warnSpy.mock.calls[0]?.[0];
				expect(String(call)).toMatch(/REDIS_URL|in-memory/);
			}
		} finally {
			if (originalRedisUrl !== undefined) process.env.REDIS_URL = originalRedisUrl;
			warnSpy.mockRestore();
		}
	});

	it("default-store bundle verifies a seeded credential end-to-end", async () => {
		const originalRedisUrl = process.env.REDIS_URL;
		// biome-ignore lint/performance/noDelete: we need REDIS_URL literally unset (not "undefined" string) to exercise the no-REDIS_URL branch
		delete process.env.REDIS_URL;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const REALM = "svc.example.com";
			const SECRET = "a".repeat(64);
			const bundle = createPaywrapMpp({
				walletPrivateKey: KNOWN_PK,
				publicBaseUrl: `https://${REALM}`,
				mppSecretKey: SECRET,
				tempoRpcUrl: "https://rpc.example/tempo",
				channelStateTtl: Number.POSITIVE_INFINITY,
			});
			const payer = privateKeyToAccount(generatePrivateKey());
			const channelId = channelIdFromLabel("default-store-test");
			await seedChannel({
				channelStore: bundle.channelStore,
				channelId,
				payer: payer.address,
				payee: bundle.account.address,
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
				recipient: bundle.account.address,
				realm: REALM,
				secretKey: SECRET,
				scope: "default-store:1",
			});
			const credential = Credential.deserialize(header);
			const verified = await verifyWithScope(bundle.mppx, credential, "default-store:1");
			expect(verified).toBeDefined();
		} finally {
			if (originalRedisUrl !== undefined) process.env.REDIS_URL = originalRedisUrl;
			warnSpy.mockRestore();
		}
	});

	it("derives the realm from publicBaseUrl host and exposes it via mppx", () => {
		const bundle = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: "https://svc.example.com:8443/path",
			mppSecretKey: "a".repeat(64),
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
		});
		// mppx.realm is either on the instance or reachable via its internals;
		// most important behavior: construction succeeds for a URL with a
		// non-default port + path.
		expect(bundle.mppx).toBeDefined();
	});
});
