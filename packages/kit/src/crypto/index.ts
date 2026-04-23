import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers for encrypting secrets at rest.
 *
 * Layout: `iv(12) || tag(16) || ciphertext`. GCM is AEAD so the tag covers
 * integrity; mutated blobs fail `final()` with an auth error. Use case: a
 * paid service stores provisioned credentials so losing the DB alone doesn't
 * leak them (also need the separate per-deployment key).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyBuf = (hexKey: string): Buffer => {
	const hex = hexKey.startsWith("0x") ? hexKey.slice(2) : hexKey;
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error("paywrap/crypto: key must be 32 bytes hex (64 hex chars)");
	}
	return Buffer.from(hex, "hex");
};

/** Fresh 32-byte key as `0x`-prefixed hex. */
export const generateEncryptionKey = (): string => `0x${randomBytes(32).toString("hex")}`;

/** Encrypt a JSON-serializable value. Plaintext is `JSON.stringify`'d. */
export const encryptSecret = <T>(value: T, keyHex: string): Buffer => {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", keyBuf(keyHex), iv);
	const plaintext = Buffer.from(JSON.stringify(value), "utf8");
	const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]);
};

/** Decrypt a blob from `encryptSecret`. Throws on auth failure. */
export const decryptSecret = <T>(ciphertext: Buffer, keyHex: string): T => {
	if (ciphertext.length <= IV_BYTES + TAG_BYTES) {
		throw new Error("paywrap/crypto: ciphertext too short");
	}
	const iv = ciphertext.subarray(0, IV_BYTES);
	const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const enc = ciphertext.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", keyBuf(keyHex), iv);
	decipher.setAuthTag(tag);
	const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
	return JSON.parse(dec.toString("utf8")) as T;
};
