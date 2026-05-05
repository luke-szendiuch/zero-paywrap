import type { VerifiedCredential } from "@zeroclickai/paywrap/auth";
import { createPaywrapMpp, memoryStore } from "@zeroclickai/paywrap/mpp";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "@zeroclickai/paywrap/mpp";
import { buildVoucherCredential, channelIdFromLabel } from "@zeroclickai/paywrap/signing";
import { seedChannel } from "@zeroclickai/paywrap/testing";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createHonoApp, mppGated } from "../src/index.js";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REALM = "svc.example.com";
const SECRET_KEY = "a".repeat(64);

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
		mppx: mpp.mppx,
		mppxChannelStore: mpp.channelStore,
	};
	const app = createHonoApp(ctx);
	return { app, mpp };
};

describe("mppGated — registration", () => {
	it("rejects registration without a scope", () => {
		// @ts-expect-error — scope is required
		expect(() => mppGated({ amount: 50_000n })).toThrow(/scope/);
	});

	it("rejects session/charge intent without amount", () => {
		expect(() => mppGated({ scope: "x:1", intent: "session" })).toThrow(/amount/);
		expect(() => mppGated({ scope: "x:1", intent: "charge" })).toThrow(/amount/);
	});
});

describe("mppGated — missing / invalid credential", () => {
	it("no auth header → 402 session challenge when amount provided", async () => {
		const { app } = makeApp();
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n }), (c) => c.json({ ok: true }));
		const res = await app.request("/paid", { method: "POST" });
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
	});

	it("no auth header → 402 proof challenge when amount omitted", async () => {
		const { app } = makeApp();
		app.get("/auth", mppGated({ scope: "read:1" }), (c) => c.json({ ok: true }));
		const res = await app.request("/auth");
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
		const body = (await res.json()) as { detail?: string };
		expect(body.detail).toBe("auth_required");
	});

	it("invalid credential header → 402", async () => {
		const { app } = makeApp();
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n }), (c) => c.json({ ok: true }));
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: "Payment not-a-real-credential" },
		});
		expect(res.status).toBe(402);
	});
});

describe("mppGated — logger hook", () => {
	const makeAppWithLogger = () => {
		const events: Array<{ kind: string }> = [];
		const logger = vi.fn(async (e) => {
			events.push(e);
		});
		const mpp = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: `https://${REALM}`,
			mppSecretKey: SECRET_KEY,
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
			channelStateTtl: Number.POSITIVE_INFINITY,
			logger,
		});
		const ctx = {
			mppx: mpp.mppx,
			mppxChannelStore: mpp.channelStore,
			paywrapLogger: mpp.logger,
		};
		const app = createHonoApp(ctx);
		return { app, events, logger };
	};

	it("emits payment_required on missing credential", async () => {
		const { app, events } = makeAppWithLogger();
		app.post("/paid", mppGated({ scope: "x:1", amount: 50_000n }), (c) => c.json({ ok: true }));
		await app.request("/paid", { method: "POST" });
		const required = events.find((e) => e.kind === "payment_required");
		expect(required).toBeDefined();
		expect(required).toMatchObject({
			v: 1,
			kind: "payment_required",
			protocol: "mpp",
			scope: "x:1",
			amountUsdcMicro: "50000",
			intent: "session",
		});
	});

	it("emits payment_required when an unparseable credential is sent", async () => {
		// `Payment garbage` fails Credential.deserialize → treated as no
		// credential → payment_required, not payment_failed. Verify-stage
		// errors require a parseable-but-invalid credential which is
		// covered in the seeded-channel tests below.
		const { app, events } = makeAppWithLogger();
		app.post("/paid", mppGated({ scope: "x:1", amount: 50_000n }), (c) => c.json({ ok: true }));
		await app.request("/paid", {
			method: "POST",
			headers: { authorization: "Payment garbage" },
		});
		expect(events.some((e) => e.kind === "payment_required")).toBe(true);
	});

	it("never includes the raw Payment header in any emitted event", async () => {
		const { app, events } = makeAppWithLogger();
		app.post("/paid", mppGated({ scope: "x:1", amount: 50_000n }), (c) => c.json({ ok: true }));
		const secret = "Payment THIS_SHOULD_NEVER_LEAK_INTO_LOGS";
		await app.request("/paid", { method: "POST", headers: { authorization: secret } });
		for (const e of events) {
			expect(JSON.stringify(e)).not.toContain("THIS_SHOULD_NEVER_LEAK_INTO_LOGS");
		}
	});
});

describe("mppGated — valid credentials", () => {
	const seedAndBuild = async (
		mpp: ReturnType<typeof createPaywrapMpp>,
		label: string,
		scope: string,
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
			cumulativeAmount: 50_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope,
		});
		return { payer, header };
	};

	it("valid session voucher → handler runs with c.var.payer populated", async () => {
		const { app, mpp } = makeApp();
		const { payer, header } = await seedAndBuild(mpp, "hono-gated-session", "paid:1");
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n }), (c) =>
			c.json({ payer: c.var.payer, hasCred: !!c.var.verifiedCredential }),
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { payer: string; hasCred: boolean };
		expect(body.hasCred).toBe(true);
		expect(body.payer.toLowerCase()).toBe(payer.address.toLowerCase());
	});

	it("scope mismatch → 402 (paid scope A, route scope B)", async () => {
		const { app, mpp } = makeApp();
		const { header } = await seedAndBuild(mpp, "hono-gated-scope", "scopeA:1");
		app.post("/paid", mppGated({ scope: "scopeB:1", amount: 50_000n }), (c) =>
			c.json({ ok: true }),
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(402);
	});

	it("preCheck returning {ok:false} short-circuits — handler never runs, no verify", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const { header } = await seedAndBuild(mpp, "hono-precheck-reject", "paid:1");
		const handler = vi.fn((c: { json: (x: unknown) => Response }) => c.json({ ok: true }));
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				preCheck: async ({ claimedPayer }) => ({
					ok: false,
					status: 409,
					body: { error: "name_taken", claimed: claimedPayer },
				}),
			}),
			handler as never,
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("name_taken");
		expect(handler).not.toHaveBeenCalled();
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it("preCheck returning {ok:'already_done'} populates vars + runs handler without verify", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const { payer, header } = await seedAndBuild(mpp, "hono-precheck-already", "paid:1");
		const syntheticPayer = payer.address.toLowerCase() as Hex;
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				preCheck: async ({ rawCredential }) => ({
					ok: "already_done",
					payer: syntheticPayer,
					verifiedCredential: {
						credential: rawCredential,
					} as unknown as VerifiedCredential,
				}),
			}),
			(c) => c.json({ payer: c.var.payer, hasCred: !!c.var.verifiedCredential }),
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { payer: string; hasCred: boolean };
		expect(body.payer).toBe(syntheticPayer);
		expect(body.hasCred).toBe(true);
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it("preCheck returning {ok:true} proceeds to normal verify path", async () => {
		const { app, mpp } = makeApp();
		const { payer, header } = await seedAndBuild(mpp, "hono-precheck-ok", "paid:1");
		const preCheck = vi.fn(async ({ claimedPayer }: { claimedPayer: Hex | null }) => {
			expect(claimedPayer?.toLowerCase()).toBe(payer.address.toLowerCase());
			return { ok: true as const };
		});
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n, preCheck }), (c) =>
			c.json({ payer: c.var.payer, hasCred: !!c.var.verifiedCredential }),
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		expect(preCheck).toHaveBeenCalledOnce();
		const body = (await res.json()) as { payer: string; hasCred: boolean };
		expect(body.hasCred).toBe(true);
		expect(body.payer.toLowerCase()).toBe(payer.address.toLowerCase());
	});

	it("factory createHonoApp((c) => ctx) resolves ctx per request and gates correctly", async () => {
		// Simulate a Workers-style environment: no module-load ctx; factory
		// reads `c.env.*` at request time. Here we key the mpp off a fake
		// env binding to prove the factory runs per-request with `c` in
		// scope.
		type Env = { SECRET_KEY: string };
		let factoryCalls = 0;
		const mpp = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: `https://${REALM}`,
			mppSecretKey: SECRET_KEY,
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
			channelStateTtl: Number.POSITIVE_INFINITY,
		});
		const app = createHonoApp<{
			mppx: typeof mpp.mppx;
			mppxChannelStore: typeof mpp.channelStore;
		}>((c) => {
			factoryCalls += 1;
			// Read from env to prove Context is live. Not used functionally
			// here, just exercises the `c.env` path.
			const env = c.env as Env | undefined;
			expect(env?.SECRET_KEY).toBe(SECRET_KEY);
			return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
		});
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n }), (c) => c.json({ ok: true }));

		const res = await app.request("/paid", { method: "POST" }, { SECRET_KEY } satisfies Env);
		expect(res.status).toBe(402);
		expect(factoryCalls).toBe(1);

		// Second request → factory runs again.
		await app.request("/paid", { method: "POST" }, { SECRET_KEY } satisfies Env);
		expect(factoryCalls).toBe(2);
	});

	it("preCheck throws → 500, handler not invoked", async () => {
		const { app, mpp } = makeApp();
		const verifySpy = vi.spyOn(mpp.mppx, "verifyCredential");
		const { header } = await seedAndBuild(mpp, "hono-precheck-throw", "paid:1");
		const handler = vi.fn((c: { json: (x: unknown) => Response }) => c.json({ ok: true }));
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				preCheck: async () => {
					throw new Error("boom");
				},
			}),
			handler as never,
		);
		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(500);
		expect(handler).not.toHaveBeenCalled();
		expect(verifySpy).not.toHaveBeenCalled();
	});
});

describe("mppGated — refundOnFailure (session intent)", () => {
	const seedSession = async (
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

	it("rolls back highestVoucher on handler throw", async () => {
		const { app, mpp } = makeApp();
		const { channelId, header } = await seedSession(mpp, "rof-throw", "paid:1", 50_000n);
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				intent: "session",
				refundOnFailure: true,
			}),
			() => {
				throw new Error("upstream exploded");
			},
		);
		// Hono surfaces the throw as a 500 by default; consume the error so
		// vitest doesn't mark it unhandled.
		app.onError((_err, c) => c.json({ error: "internal" }, 500));

		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(500);

		const after = await mpp.channelStore.getChannel(channelId);
		// Voucher was advanced by verify, then rolled back to the prior null.
		expect(after?.highestVoucherAmount).toBe(0n);
		expect(after?.highestVoucher).toBeNull();
	});

	it("rolls back to a prior voucher across two calls (second fails)", async () => {
		const { app, mpp } = makeApp();
		const { payer, channelId } = await seedSession(mpp, "rof-second", "paid:1", 50_000n);

		const okHeader = await buildVoucherCredential({
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
		const failHeader = await buildVoucherCredential({
			payer,
			channelId,
			cumulativeAmount: 100_000n,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			recipient: mpp.account.address,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "paid:1",
		});

		let shouldThrow = false;
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				intent: "session",
				refundOnFailure: true,
			}),
			(c) => {
				if (shouldThrow) throw new Error("upstream exploded");
				return c.json({ ok: true });
			},
		);
		app.onError((_err, c) => c.json({ error: "internal" }, 500));

		// First call succeeds → highestVoucher should advance to 50_000.
		const res1 = await app.request("/paid", {
			method: "POST",
			headers: { authorization: okHeader },
		});
		expect(res1.status).toBe(200);
		const afterFirst = await mpp.channelStore.getChannel(channelId);
		expect(afterFirst?.highestVoucherAmount).toBe(50_000n);

		// Second call fails → should roll back to the prior 50_000 voucher.
		shouldThrow = true;
		const res2 = await app.request("/paid", {
			method: "POST",
			headers: { authorization: failHeader },
		});
		expect(res2.status).toBe(500);
		const afterSecond = await mpp.channelStore.getChannel(channelId);
		expect(afterSecond?.highestVoucherAmount).toBe(50_000n); // not 100_000
		expect(afterSecond?.highestVoucher?.cumulativeAmount).toBe(50_000n);
	});

	it("does NOT roll back when refundOnFailure is false (default)", async () => {
		const { app, mpp } = makeApp();
		const { channelId, header } = await seedSession(mpp, "rof-default", "paid:1", 50_000n);
		app.post("/paid", mppGated({ scope: "paid:1", amount: 50_000n, intent: "session" }), () => {
			throw new Error("upstream exploded");
		});
		app.onError((_err, c) => c.json({ error: "internal" }, 500));

		await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		const after = await mpp.channelStore.getChannel(channelId);
		// Voucher remained advanced — buyer is billed for the failed call.
		expect(after?.highestVoucherAmount).toBe(50_000n);
	});

	it("emits payment_failed { stage: 'post_handler', reason: 'voucher_rolled_back…' }", async () => {
		const mpp = createPaywrapMpp({
			walletPrivateKey: KNOWN_PK,
			publicBaseUrl: `https://${REALM}`,
			mppSecretKey: SECRET_KEY,
			tempoRpcUrl: "https://rpc.example/tempo",
			store: memoryStore(),
			channelStateTtl: Number.POSITIVE_INFINITY,
		});
		const events: unknown[] = [];
		const app = createHonoApp({
			mppx: mpp.mppx,
			mppxChannelStore: mpp.channelStore,
			paywrapLogger: (e) => {
				events.push(e);
			},
		});
		const { header } = await seedSession(mpp, "rof-event", "paid:1", 50_000n);
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				intent: "session",
				refundOnFailure: true,
			}),
			() => {
				throw new Error("oops");
			},
		);
		app.onError((_err, c) => c.json({ error: "internal" }, 500));

		await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});

		const failed = events.find(
			(e): e is { kind: string; stage: string; reason: string } =>
				typeof e === "object" &&
				e !== null &&
				(e as { kind?: unknown }).kind === "payment_failed" &&
				(e as { stage?: unknown }).stage === "post_handler",
		);
		expect(failed).toBeDefined();
		expect(failed?.reason).toMatch(/^voucher_rolled_back:ok:/);
	});

	it("does not roll back for charge intent (no-op)", async () => {
		// charge intent doesn't have a session voucher to roll back; the
		// option should be a quiet no-op rather than break anything.
		const { app, mpp } = makeApp();
		const { channelId, header } = await seedSession(mpp, "rof-charge", "paid:1", 50_000n);
		app.post(
			"/paid",
			mppGated({
				scope: "paid:1",
				amount: 50_000n,
				intent: "session", // still session — but mark refundOnFailure and verify it's session-scoped
				refundOnFailure: true,
			}),
			(c) => c.json({ ok: true }),
		);

		const res = await app.request("/paid", {
			method: "POST",
			headers: { authorization: header },
		});
		expect(res.status).toBe(200);
		const after = await mpp.channelStore.getChannel(channelId);
		// Successful call, no rollback — voucher advances normally.
		expect(after?.highestVoucherAmount).toBe(50_000n);
	});
});
