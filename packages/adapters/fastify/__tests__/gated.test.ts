import type { VerifiedCredential } from "@zerorun/paywrap/auth";
import { createPaywrapMpp, memoryStore } from "@zerorun/paywrap/mpp";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "@zerorun/paywrap/mpp";
import { buildVoucherCredential, channelIdFromLabel } from "@zerorun/paywrap/signing";
import { seedChannel } from "@zerorun/paywrap/testing";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createFastifyApp } from "../src/index.js";

// Anvil test account index 0 — known-answer seller key.
const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REALM = "svc.example.com";
const SECRET_KEY = "a".repeat(64);

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

const makeApp = () => {
	const mpp = createPaywrapMpp({
		walletPrivateKey: KNOWN_PK,
		publicBaseUrl: `https://${REALM}`,
		mppSecretKey: SECRET_KEY,
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
		channelStateTtl: Number.POSITIVE_INFINITY,
	});
	const ctx = {
		logger: silentLogger,
		mppx: mpp.mppx,
		mppxChannelStore: mpp.channelStore,
	};
	const app = createFastifyApp(ctx);
	return { app, mpp };
};

describe("app.mppGated — registration", () => {
	it("rejects registration without a scope", async () => {
		const { app } = makeApp();
		// @ts-expect-error — scope is required
		expect(() => app.mppGated({ amount: 50_000n })).toThrow(/scope/);
		await app.close();
	});

	it("rejects session/charge intent without amount", async () => {
		const { app } = makeApp();
		expect(() => app.mppGated({ scope: "x:1", intent: "session" })).toThrow(/amount/);
		expect(() => app.mppGated({ scope: "x:1", intent: "charge" })).toThrow(/amount/);
		await app.close();
	});
});

describe("app.mppGated — missing / invalid credential", () => {
	it("no auth header → 402 session challenge when amount provided", async () => {
		const { app } = makeApp();
		app.post(
			"/paid",
			{ preHandler: app.mppGated({ scope: "paid:1", amount: 50_000n }) },
			async () => ({ ok: true }),
		);
		const res = await app.inject({ method: "POST", url: "/paid" });
		expect(res.statusCode).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		await app.close();
	});

	it("no auth header → 402 proof challenge when amount omitted", async () => {
		const { app } = makeApp();
		app.get("/auth", { preHandler: app.mppGated({ scope: "read:1" }) }, async () => ({ ok: true }));
		const res = await app.inject({ method: "GET", url: "/auth" });
		expect(res.statusCode).toBe(402);
		expect(res.headers["www-authenticate"]).toMatch(/^Payment /);
		expect(JSON.parse(res.body)).toMatchObject({ detail: "auth_required" });
		await app.close();
	});

	it("invalid credential header → 402", async () => {
		const { app } = makeApp();
		app.post(
			"/paid",
			{ preHandler: app.mppGated({ scope: "paid:1", amount: 50_000n }) },
			async () => ({ ok: true }),
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: "Payment not-a-real-credential" },
		});
		expect(res.statusCode).toBe(402);
		await app.close();
	});
});

describe("app.mppGated — valid credentials", () => {
	it("valid session voucher → handler runs with req.payer populated", async () => {
		const { app, mpp } = makeApp();
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-session-test");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});
		app.post(
			"/paid",
			{ preHandler: app.mppGated({ scope: "paid:1", amount: 50_000n }) },
			async (req) => ({ payer: req.payer, hasCred: !!req.verifiedCredential }),
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.hasCred).toBe(true);
		expect(body.payer.toLowerCase()).toBe(payer.address.toLowerCase());
		await app.close();
	});

	it("preCheck returning {ok:false} short-circuits — handler never runs, no verify attempted", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-precheck-reject");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});
		const handler = vi.fn(async () => ({ ok: true }));
		app.post(
			"/paid",
			{
				preHandler: app.mppGated({
					scope: "paid:1",
					amount: 50_000n,
					preCheck: async ({ claimedPayer }) => ({
						ok: false,
						status: 409,
						body: { error: "name_taken", claimed: claimedPayer },
					}),
				}),
			},
			handler,
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.body)).toMatchObject({ error: "name_taken" });
		expect(handler).not.toHaveBeenCalled();
		expect(verifySpy).not.toHaveBeenCalled();
		await app.close();
	});

	it("preCheck returning {ok:'already_done'} populates req.payer + runs handler without verify", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-precheck-already");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});
		const syntheticPayer = payer.address.toLowerCase() as Hex;
		app.post(
			"/paid",
			{
				preHandler: app.mppGated({
					scope: "paid:1",
					amount: 50_000n,
					preCheck: async ({ rawCredential }) => ({
						ok: "already_done",
						payer: syntheticPayer,
						// In practice the caller constructs this from a prior
						// verify record; the test only asserts it round-trips
						// onto req.verifiedCredential without mppGated ever
						// calling verify.
						verifiedCredential: {
							credential: rawCredential,
						} as unknown as VerifiedCredential,
					}),
				}),
			},
			async (req) => ({ payer: req.payer, hasCred: !!req.verifiedCredential }),
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.payer).toBe(syntheticPayer);
		expect(body.hasCred).toBe(true);
		expect(verifySpy).not.toHaveBeenCalled();
		await app.close();
	});

	it("preCheck returning {ok:true} proceeds to normal verify path", async () => {
		const { app, mpp } = makeApp();
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-precheck-ok");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});
		const preCheck = vi.fn(async ({ claimedPayer }: { claimedPayer: Hex | null }) => {
			// claimedPayer for a session voucher is looked up from the
			// channel store — it should match the seeded payer.
			expect(claimedPayer?.toLowerCase()).toBe(payer.address.toLowerCase());
			return { ok: true as const };
		});
		app.post(
			"/paid",
			{
				preHandler: app.mppGated({ scope: "paid:1", amount: 50_000n, preCheck }),
			},
			async (req) => ({ payer: req.payer, hasCred: !!req.verifiedCredential }),
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(200);
		expect(preCheck).toHaveBeenCalledOnce();
		const body = JSON.parse(res.body);
		expect(body.hasCred).toBe(true);
		expect(body.payer.toLowerCase()).toBe(payer.address.toLowerCase());
		await app.close();
	});

	it("preCheck throws → 500, handler not invoked", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-precheck-throw");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});
		const handler = vi.fn(async () => ({ ok: true }));
		app.post(
			"/paid",
			{
				preHandler: app.mppGated({
					scope: "paid:1",
					amount: 50_000n,
					preCheck: async () => {
						throw new Error("boom");
					},
				}),
			},
			handler,
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(500);
		expect(handler).not.toHaveBeenCalled();
		expect(verifySpy).not.toHaveBeenCalled();
		await app.close();
	});

	it("scope mismatch → 402 (paid scope A, route scope B)", async () => {
		const { app, mpp } = makeApp();
		const payer = privateKeyToAccount(generatePrivateKey());
		const channelId = channelIdFromLabel("gated-scope-test");
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "scopeA:1",
		});
		app.post(
			"/paid",
			{ preHandler: app.mppGated({ scope: "scopeB:1", amount: 50_000n }) },
			async () => ({ ok: true }),
		);
		const res = await app.inject({
			method: "POST",
			url: "/paid",
			headers: { authorization: header },
		});
		expect(res.statusCode).toBe(402);
		await app.close();
	});
});
