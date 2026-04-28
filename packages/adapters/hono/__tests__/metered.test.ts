import { createPaywrapMpp, memoryStore } from "@zeroclickai/paywrap/mpp";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "@zeroclickai/paywrap/mpp";
import { buildVoucherCredential, channelIdFromLabel } from "@zeroclickai/paywrap/signing";
import { seedChannel } from "@zeroclickai/paywrap/testing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createHonoApp, mppMetered } from "../src/index.js";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REALM = "svc.example.com";
const SECRET_KEY = "a".repeat(64);

const decodeReceipt = (header: string) => {
	const padLen = (4 - (header.length % 4)) % 4;
	const padded = header.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
	const json = Buffer.from(padded, "base64").toString("utf8");
	return JSON.parse(json) as Record<string, unknown>;
};

const makeApp = (logger?: ReturnType<typeof vi.fn>) => {
	const mpp = createPaywrapMpp({
		walletPrivateKey: KNOWN_PK,
		publicBaseUrl: `https://${REALM}`,
		mppSecretKey: SECRET_KEY,
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
		channelStateTtl: Number.POSITIVE_INFINITY,
		...(logger ? { logger } : {}),
	});
	const ctx = {
		mppx: mpp.mppx,
		mppxChannelStore: mpp.channelStore,
		paywrapLogger: mpp.logger,
	};
	const app = createHonoApp(ctx);
	return { app, mpp };
};

const seedAndBuild = async (
	mpp: ReturnType<typeof createPaywrapMpp>,
	label: string,
	scope: string,
	cumulativeAmount: bigint,
) => {
	const payer = privateKeyToAccount(generatePrivateKey());
	const channelId = channelIdFromLabel(label);
	await seedChannel({
		channelStore: mpp.channelStore,
		channelId,
		payer: payer.address,
		payee: mpp.account.address,
		escrowContract: TEMPO_ESCROW,
		chainId: TEMPO_CHAIN_ID,
		deposit: 10_000_000n,
	});
	const header = await buildVoucherCredential({
		payer,
		channelId,
		cumulativeAmount,
		escrowContract: TEMPO_ESCROW,
		chainId: TEMPO_CHAIN_ID,
		recipient: mpp.account.address,
		realm: REALM,
		secretKey: SECRET_KEY,
		scope,
	});
	return { payer, channelId, header };
};

describe("mppMetered — registration", () => {
	it("rejects missing scope", () => {
		// @ts-expect-error — scope is required
		expect(() => mppMetered({ maxAmount: 50_000n })).toThrow(/scope/);
	});

	it("rejects missing or non-positive maxAmount", () => {
		expect(() => mppMetered({ scope: "x:1", maxAmount: 0n })).toThrow(/maxAmount/);
		// @ts-expect-error — maxAmount must be bigint
		expect(() => mppMetered({ scope: "x:1", maxAmount: 100 })).toThrow(/maxAmount/);
	});
});

describe("mppMetered — missing credential", () => {
	it("returns 402 session challenge for the maxAmount", async () => {
		const { app } = makeApp();
		app.post("/listen", mppMetered({ scope: "listen:1", maxAmount: 200_000n }), (c) =>
			c.json({ ok: true }),
		);
		const res = await app.request("/listen", { method: "POST" });
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
	});
});

describe("mppMetered — happy path (handler calls settle)", () => {
	it("emits Payment-Receipt with the actual amount, not the max", async () => {
		const { app, mpp } = makeApp();
		const { header } = await seedAndBuild(mpp, "metered-happy", "listen:1", 200_000n);
		app.post("/listen", mppMetered({ scope: "listen:1", maxAmount: 200_000n }), (c) => {
			c.var.settle(42_000n); // actual cost
			return c.json({ ok: true });
		});
		const res = await app.request("/listen", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const receiptHeader = res.headers.get("Payment-Receipt");
		expect(receiptHeader).toBeTruthy();
		const receipt = decodeReceipt(receiptHeader!);
		expect(receipt.acceptedCumulative).toBe("42000");
		expect(receipt.spent).toBe("42000");
		expect(receipt.channelId).toBeTruthy();
		expect(receipt.challengeId).toBeTruthy();
	});
});

describe("mppMetered — handler forgets to call settle", () => {
	it("falls back to maxAmount and logs fallback:true", async () => {
		const events: Array<Record<string, unknown>> = [];
		const logger = vi.fn(async (e) => {
			events.push(e);
		});
		const { app, mpp } = makeApp(logger);
		const { header } = await seedAndBuild(mpp, "metered-fallback", "listen:1", 200_000n);
		app.post("/listen", mppMetered({ scope: "listen:1", maxAmount: 200_000n }), (c) =>
			c.json({ ok: true }),
		);
		const res = await app.request("/listen", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const receipt = decodeReceipt(res.headers.get("Payment-Receipt")!);
		expect(receipt.acceptedCumulative).toBe("200000");
		const settled = events.find((e) => e.kind === "payment_metered_settled");
		expect(settled).toBeTruthy();
		expect((settled as { fallback: boolean }).fallback).toBe(true);
		expect((settled as { actualAmountUsdcMicro: string }).actualAmountUsdcMicro).toBe("200000");
	});
});

describe("mppMetered — handler tries to overcharge", () => {
	it("clamps to maxAmount and logs payment_failed", async () => {
		const events: Array<Record<string, unknown>> = [];
		const logger = vi.fn(async (e) => {
			events.push(e);
		});
		const { app, mpp } = makeApp(logger);
		const { header } = await seedAndBuild(mpp, "metered-clamp", "listen:1", 100_000n);
		app.post("/listen", mppMetered({ scope: "listen:1", maxAmount: 100_000n }), (c) => {
			c.var.settle(500_000n); // way over max
			return c.json({ ok: true });
		});
		const res = await app.request("/listen", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const receipt = decodeReceipt(res.headers.get("Payment-Receipt")!);
		expect(receipt.acceptedCumulative).toBe("100000");
		const failed = events.find(
			(e) =>
				e.kind === "payment_failed" &&
				typeof (e as { reason?: unknown }).reason === "string" &&
				(e as { reason: string }).reason.startsWith("metered_actual_exceeded_max"),
		);
		expect(failed).toBeTruthy();
	});
});

describe("mppMetered — settle hook overwrites", () => {
	it("last call wins", async () => {
		const { app, mpp } = makeApp();
		const { header } = await seedAndBuild(mpp, "metered-overwrite", "listen:1", 200_000n);
		app.post("/listen", mppMetered({ scope: "listen:1", maxAmount: 200_000n }), (c) => {
			c.var.settle(10_000n);
			c.var.settle(80_000n);
			return c.json({ ok: true });
		});
		const res = await app.request("/listen", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(decodeReceipt(res.headers.get("Payment-Receipt")!).acceptedCumulative).toBe("80000");
	});
});

describe("mppMetered — scope mismatch", () => {
	it("voucher signed for wrong scope → 402, no Payment-Receipt", async () => {
		const { app, mpp } = makeApp();
		const { header } = await seedAndBuild(mpp, "metered-scope", "scopeA:1", 200_000n);
		app.post("/listen", mppMetered({ scope: "scopeB:1", maxAmount: 200_000n }), (c) => {
			c.var.settle(50_000n);
			return c.json({ ok: true });
		});
		const res = await app.request("/listen", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(402);
		expect(res.headers.get("Payment-Receipt")).toBeNull();
	});
});

describe("mppMetered — payment_metered_settled log shape", () => {
	it("contains both max and actual amounts plus channelId", async () => {
		const events: Array<Record<string, unknown>> = [];
		const logger = vi.fn(async (e) => {
			events.push(e);
		});
		const { app, mpp } = makeApp(logger);
		const { channelId, header } = await seedAndBuild(mpp, "metered-log", "listen:1", 200_000n);
		app.post(
			"/listen",
			mppMetered({ scope: "listen:1", maxAmount: 200_000n, meta: { sku: "deepgram-listen:v1" } }),
			(c) => {
				c.var.settle(33_000n);
				return c.json({ ok: true });
			},
		);
		await app.request("/listen", { method: "POST", headers: { authorization: header } });
		const settled = events.find((e) => e.kind === "payment_metered_settled");
		expect(settled).toMatchObject({
			kind: "payment_metered_settled",
			protocol: "mpp",
			maxAmountUsdcMicro: "200000",
			actualAmountUsdcMicro: "33000",
			fallback: false,
			sku: "deepgram-listen:v1",
			channelId,
		});
	});
});
