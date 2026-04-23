import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers for encrypting secrets at rest.
 *
 * Use case: a paid service provisions a resource whose access credentials
 * (DB password, API token, etc.) must be stored for later retrieval by the
 * paying wallet. Storing them plaintext means losing the DB leaks every
 * credential; AEAD-encrypting them with a separate per-deployment key means
 * the DB alone is useless without also compromising the encryption key.
 *
 * Layout: `iv(12) || tag(16) || ciphertext`. GCM is AEAD so the tag covers
 * integrity of the ciphertext; a mutated blob fails `final()` with an
 * authentication error.
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

/** Generate a fresh 32-byte key as `0x`-prefixed hex. */
export const generateEncryptionKey = (): string => `0x${randomBytes(32).toString("hex")}`;

/**
 * Encrypt an arbitrary JSON-serializable value. Returns a single `Buffer` you
 * can store as `bytea` in Postgres or base64-string anywhere else. The plaintext
 * is `JSON.stringify`'d — don't pass a function or a circular object.
 */
export const encryptSecret = <T>(value: T, keyHex: string): Buffer => {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", keyBuf(keyHex), iv);
	const plaintext = Buffer.from(JSON.stringify(value), "utf8");
	const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]);
};

/**
 * Decrypt a blob produced by `encryptSecret`. Throws on authentication
 * failure (wrong key, truncation, tampering).
 */
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
