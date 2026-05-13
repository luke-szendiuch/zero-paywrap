import { Credential } from "mppx";
import { Session } from "mppx/tempo";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW, TEMPO_USDC } from "../src/mpp/constants.js";
import { memoryStore } from "../src/mpp/stores.js";
import {
	buildChargeCredential,
	buildVoucherCredential,
	channelIdFromLabel,
	signVoucher,
} from "../src/signing/index.js";
import { seedChannel } from "../src/testing/index.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const SECRET_KEY = "a".repeat(64);

/**
 * Decode `challenge.opaque` (base64url-encoded JSON of the meta map; opaque
 * serialization changed to spec-compliant base64url in mppx 0.6.4) back into
 * a record. Tests assert against the decoded shape so they exercise the full
 * round-trip, not an in-memory pre-serialize view. See ADS-678.
 */
const decodeOpaque = (opaque: unknown): Record<string, string> => {
	if (typeof opaque !== "string") {
		throw new Error(`decodeOpaque: expected string, got ${typeof opaque}`);
	}
	const padLen = (4 - (opaque.length % 4)) % 4;
	const padded = opaque.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
	return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
};

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
		// scope ends up under the reserved `_mppx_scope` key inside the
		// base64url-encoded `opaque` blob (mppx ≥0.6.4 round-trip shape).
		expect(decodeOpaque(credential.challenge.opaque)._mppx_scope).toBe("my-scope:1");
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
		const opaque = decodeOpaque(credential.challenge.opaque);
		expect(opaque.route).toBe("/v1/provision");
		expect(opaque.sku).toBe("alpha");
		expect(opaque._mppx_scope).toBe("scoped");
	});
});

describe("signing.buildChargeCredential", () => {
	it("produces a `Payment ...` header that deserializes to a tempo.charge proof credential", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const serialized = await buildChargeCredential({
			payer,
			recipient: RECIPIENT,
			amountMicro: 20_000n,
			realm: "api.example.com",
			secretKey: SECRET_KEY,
			scope: "joke:1",
		});

		expect(typeof serialized).toBe("string");
		expect(serialized.startsWith("Payment ")).toBe(true);

		const credential = Credential.deserialize<{ signature: string; type: string }>(serialized);
		expect(credential.payload.type).toBe("proof");
		expect(credential.payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
		expect(credential.challenge.realm).toBe("api.example.com");
		expect(credential.challenge.method).toBe("tempo");
		expect(credential.challenge.intent).toBe("charge");
		expect(credential.challenge.request.amount).toBe("20000");
		// scope ends up under the reserved `_mppx_scope` key inside the
		// base64url-encoded `opaque` blob (mppx ≥0.6.4 round-trip shape).
		expect(decodeOpaque(credential.challenge.opaque)._mppx_scope).toBe("joke:1");
		// source is a did:pkh with the payer's address + default chainId (4217)
		expect(credential.source?.toLowerCase()).toBe(
			`did:pkh:eip155:${TEMPO_CHAIN_ID}:${payer.address}`.toLowerCase(),
		);
	});

	it("produces a zero-amount proof credential when amountMicro === 0n", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const serialized = await buildChargeCredential({
			payer,
			recipient: RECIPIENT,
			amountMicro: 0n,
			realm: "api.example.com",
			secretKey: SECRET_KEY,
			scope: "auth:1",
		});

		const credential = Credential.deserialize<{ type: string }>(serialized);
		expect(credential.challenge.request.amount).toBe("0");
		expect(credential.payload.type).toBe("proof");
	});

	it("merges extra meta into opaque alongside the scope", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const serialized = await buildChargeCredential({
			payer,
			recipient: RECIPIENT,
			amountMicro: 1_000n,
			realm: "api.example.com",
			secretKey: SECRET_KEY,
			scope: "m:1",
			meta: { sku: "alpha" },
		});
		const credential = Credential.deserialize(serialized);
		const opaque = decodeOpaque(credential.challenge.opaque);
		expect(opaque.sku).toBe("alpha");
		expect(opaque._mppx_scope).toBe("m:1");
	});

	// Pins the v=2 Proof EIP-712 contract (realm binding added in mppx 0.6.5).
	// If anyone drifts the inline contract in `signing/index.ts` away from
	// mppx's published `tempo/internal/proof.js` (e.g. reverts to v=1, or
	// partially updates),
	// `recoverTypedDataAddress` will return a different address and this test
	// fails at unit-test time — long before a CLI-built credential is rejected
	// in production with "Proof signature does not match source." See ADS-678.
	it("signs the typed data under the v=2 Proof contract (realm included)", async () => {
		const payer = privateKeyToAccount(generatePrivateKey());
		const realm = "api.example.com";
		const serialized = await buildChargeCredential({
			payer,
			recipient: RECIPIENT,
			amountMicro: 0n,
			realm,
			secretKey: SECRET_KEY,
			scope: "v2-pin:1",
		});
		const credential = Credential.deserialize<{
			signature: `0x${string}`;
			type: string;
		}>(serialized);
		const recovered = await recoverTypedDataAddress({
			domain: { name: "MPP", version: "2", chainId: TEMPO_CHAIN_ID },
			types: {
				Proof: [
					{ name: "challengeId", type: "string" },
					{ name: "realm", type: "string" },
				],
			},
			primaryType: "Proof",
			message: { challengeId: credential.challenge.id, realm },
			signature: credential.payload.signature,
		});
		expect(recovered.toLowerCase()).toBe(payer.address.toLowerCase());
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
