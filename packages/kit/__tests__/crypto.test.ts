import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "../src/crypto/index.js";

describe("crypto", () => {
	it("round-trips a value", () => {
		const key = generateEncryptionKey();
		const secret = { host: "redis.example", port: 6379, password: "hunter2" };
		const ct = encryptSecret(secret, key);
		const back = decryptSecret<typeof secret>(ct, key);
		expect(back).toEqual(secret);
	});

	it("accepts both 0x-prefixed and unprefixed hex keys", () => {
		const raw = generateEncryptionKey().slice(2);
		const ct = encryptSecret({ x: 1 }, raw);
		expect(decryptSecret(ct, `0x${raw}`)).toEqual({ x: 1 });
	});

	it("fails authentication on wrong key", () => {
		const ct = encryptSecret({ a: 1 }, generateEncryptionKey());
		expect(() => decryptSecret(ct, generateEncryptionKey())).toThrow();
	});

	it("fails authentication on tampered ciphertext", () => {
		const key = generateEncryptionKey();
		const ct = encryptSecret({ a: 1 }, key);
		ct[ct.length - 1] ^= 0x01;
		expect(() => decryptSecret(ct, key)).toThrow();
	});

	it("rejects a key that isn't 32 bytes of hex", () => {
		expect(() => encryptSecret({}, "0xdeadbeef")).toThrow(/32 bytes hex/);
	});

	it("rejects a truncated ciphertext", () => {
		const key = generateEncryptionKey();
		expect(() => decryptSecret<unknown>(Buffer.alloc(8), key)).toThrow(/too short/);
	});
});
