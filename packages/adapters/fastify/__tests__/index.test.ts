import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";
import { memoryStore } from "@zeroclickai/paywrap/mpp";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "@zeroclickai/paywrap/mpp";
import { buildVoucherCredential, channelIdFromLabel } from "@zeroclickai/paywrap/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
	createFastifyApp,
	extractCredential,
	sendChargeChallenge,
	sendProofChallenge,
	sendSessionChallenge,
} from "../src/index.js";

// Known-answer private key / address pair (Anvil test account index 0).
const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// Fastify's stock logger when `loggerInstance: false` is disabled — small
// stand-in that satisfies the pino-shaped interface the adapter forwards.
const silentLogger = {
	level: "silent",
	fatal: () => undefined,
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
	silent: () => undefined,
	child: () => silentLogger,
};

const makeCtx = () => {
	const mpp = createPaywrapMpp({
		walletPrivateKey: KNOWN_PK,
		publicBaseUrl: "https://svc.example.com",
		mppSecretKey: "a".repeat(64),
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
	});
	return { mppx: mpp.mppx, logger: silentLogger };
};

const makeApp = () => {
	const ctx = makeCtx();
	const app = createFastifyApp(ctx);
	return { app, ctx };
};

describe("createFastifyApp", () => {
	it("returns a fastify instance with ctx decorated", async () => {
		const { app, ctx } = makeApp();
		// @ts-expect-error — consumer-side augmentation would type this
		expect(app.ctx).toBe(ctx);
		await app.close();
	});
});

describe("sendSessionChallenge", () => {
	it("responds 402 with a Payment www-authenticate header", async () => {
		const { app } = makeApp();
		app.get("/paid", async (_req, reply) => {
			return sendSessionChallenge(app, reply, {
				amount: "0.02",
				scope: "test:1",
				detail: "pay_up",
			});
		});
		const res = await app.inject({ method: "GET", url: "/paid" });
		expect(res.statusCode).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect(JSON.parse(res.body)).toMatchObject({ detail: "pay_up" });
		await app.close();
	});
});

describe("sendChargeChallenge", () => {
	it("responds 402 for a single-shot paid charge", async () => {
		const { app } = makeApp();
		app.get("/charge", async (_req, reply) => {
			return sendChargeChallenge(app, reply, {
				amount: "0.02",
				scope: "test:charge",
				detail: "pay_up",
			});
		});
		const res = await app.inject({ method: "GET", url: "/charge" });
		expect(res.statusCode).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect(JSON.parse(res.body)).toMatchObject({ detail: "pay_up" });
		await app.close();
	});
});

describe("sendProofChallenge", () => {
	it("responds 402 with a zero-amount charge for wallet-auth", async () => {
		const { app } = makeApp();
		app.get("/auth", async (_req, reply) => {
			return sendProofChallenge(app, reply, "test:proof", "auth_required");
		});
		const res = await app.inject({ method: "GET", url: "/auth" });
		expect(res.statusCode).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect(JSON.parse(res.body)).toMatchObject({ detail: "auth_required" });
		await app.close();
	});
});

describe("extractCredential", () => {
	it("returns null for missing / empty header", () => {
		expect(extractCredential(undefined)).toBeNull();
		expect(extractCredential("")).toBeNull();
	});

	it("returns null for unparseable header", () => {
		expect(extractCredential("not a credential")).toBeNull();
		expect(extractCredential("Payment garbage-base64url")).toBeNull();
	});

	it("round-trips a real signed voucher credential with and without prefix", async () => {
		// Build a real (properly signed) voucher header via the kit helper —
		// no hand-crafted mock. This mirrors how the zero CLI produces
		// credentials on the buyer side.
		const payer = privateKeyToAccount(generatePrivateKey());
		const payee = privateKeyToAccount(generatePrivateKey());
		const header = await buildVoucherCredential({
			payer,
			recipient: payee.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			channelId: channelIdFromLabel("fastify-extract-test"),
			cumulativeAmount: 20_000n,
			realm: "svc.example.com",
			secretKey: "a".repeat(64),
			scope: "test:1",
		});

		// builder produces the full `Authorization: Payment <...>` form.
		expect(extractCredential(header)).not.toBeNull();
		// bare `<base64url>` (no "Payment " prefix) should also round-trip.
		const bare = header.replace(/^Payment /, "");
		expect(extractCredential(bare)).not.toBeNull();
	});
});
