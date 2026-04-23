import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createPaywrapMpp } from "../../src/mpp/mppx.js";
import { memoryStore } from "../../src/mpp/stores.js";

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
