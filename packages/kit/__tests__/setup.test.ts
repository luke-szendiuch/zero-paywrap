import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { generateMppSecretKey, generateWallet } from "../src/setup/index.js";

// `prefundWallet` is intentionally not tested here — it hits a live Tempo
// RPC and moves funds. Covered via the CLI's e2e smoke. (`registerWithZero`
// was removed in 0.0.2 pending Zero's public registration API.)

describe("setup.generateWallet", () => {
	it("produces a valid keypair whose address derives from the private key", () => {
		const kp = generateWallet();
		expect(kp.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
		expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		// independently derive address and confirm they match
		const derived = privateKeyToAccount(kp.privateKey).address;
		expect(kp.address).toBe(derived);
	});

	it("produces distinct keypairs across calls", () => {
		const a = generateWallet();
		const b = generateWallet();
		expect(a.privateKey).not.toBe(b.privateKey);
		expect(a.address).not.toBe(b.address);
	});
});

describe("setup.generateMppSecretKey", () => {
	it("produces 64 lowercase hex chars (32 random bytes)", () => {
		const key = generateMppSecretKey();
		expect(key).toHaveLength(64);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces distinct keys across calls", () => {
		const a = generateMppSecretKey();
		const b = generateMppSecretKey();
		expect(a).not.toBe(b);
	});
});
