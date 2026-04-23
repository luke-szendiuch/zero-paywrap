/**
 * Integration test for the /v1/joke Hono Worker.
 *
 * Boots a Hono app via `app.request()` (Hono's built-in test harness — no
 * miniflare needed). Provides a fake KV via an in-memory Map that satisfies
 * the `MinimalKVNamespace` interface the kit exposes.
 *
 * Two request round-trips:
 *
 *   1. POST /v1/joke with no auth → expect 402 + `www-authenticate` + a
 *      body carrying a `challenge` whose `intent === "charge"`.
 *
 *   2. Buyer synthesizes a signed credential using kit/mppx primitives and
 *      retries with `Authorization: Payment <credential>`.
 *
 *      CAVEAT — mppx's `tempo.charge` non-zero path REQUIRES a real on-chain
 *      USDC transfer (`hash` / serialized tx credential shape). Neither the
 *      paywrap kit nor mppx exposes a primitive to synthesize such a
 *      credential offline. To exercise the 402 → sign → 200 loop end-to-end
 *      without a blockchain, we stub `mppx.verifyCredential` to resolve for
 *      our synthesized credential. Every other path (header parse,
 *      extractCredential, scope wiring, payer resolution via `did:pkh`,
 *      handler invocation, response shape, Workers KV store interaction)
 *      runs for real against the live adapter + kit code.
 */

import { mppGated } from "@zerorun/paywrap-adapter-hono";
import { type MinimalKVNamespace, createPaywrapMpp, workersKvStore } from "@zerorun/paywrap/mpp";
import { Hono } from "hono";
import { Challenge, Credential, Expires } from "mppx";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomJoke } from "../src/jokes.js";
import { type Env, buildApp } from "../src/worker.js";

const SECRET_KEY = "a".repeat(64);
const SELLER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PUBLIC_BASE_URL = "https://paywrap-hono-joke.example.workers.dev";
const REALM = new URL(PUBLIC_BASE_URL).host;

/** In-memory KV — three-method surface matches kit's `MinimalKVNamespace`. */
const memoryKv = (): MinimalKVNamespace => {
	const store = new Map<string, string>();
	return {
		async get(key) {
			return store.get(key) ?? null;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
	};
};

const makeEnv = (): Env => ({
	PAYWRAP_KV: memoryKv(),
	WALLET_PRIVATE_KEY: SELLER_PK,
	MPP_SECRET_KEY: SECRET_KEY,
	PUBLIC_BASE_URL,
	TEMPO_RPC_URL: "https://rpc.example/tempo",
});

describe("hono-worker /v1/joke", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("GET /healthz → 200 ok", async () => {
		const app = buildApp();
		const res = await app.request("/healthz", {}, makeEnv());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("GET /.well-known/paywrap.json → manifest with joke route", async () => {
		const app = buildApp();
		const res = await app.request("/.well-known/paywrap.json", {}, makeEnv());
		expect(res.status).toBe(200);
		const manifest = (await res.json()) as {
			wallet: string;
			paidRoutes: Array<{
				path: string;
				priceUsdcMicro: string;
				protocol: string;
				sku: string;
			}>;
			freeRoutes: Array<{ path: string }>;
		};
		expect(manifest.wallet.startsWith("0x")).toBe(true);
		expect(manifest.paidRoutes).toHaveLength(1);
		expect(manifest.paidRoutes[0]).toMatchObject({
			path: "/v1/joke",
			protocol: "mpp",
			sku: "joke:1",
			priceUsdcMicro: "20000",
		});
		expect(manifest.freeRoutes.map((r) => r.path)).toContain("/healthz");
	});

	it("POST /v1/joke with no auth → 402 with charge challenge", async () => {
		const app = buildApp();
		const res = await app.request("/v1/joke", { method: "POST" }, makeEnv());
		expect(res.status).toBe(402);
		const wwwAuth = res.headers.get("www-authenticate") ?? "";
		expect(wwwAuth.startsWith("Payment ")).toBe(true);
		const body = (await res.json()) as {
			detail: string;
			challenge: {
				method: string;
				intent: string;
				realm: string;
				request: { amount: string };
				id: string;
			};
		};
		expect(body.detail).toBe("payment_required");
		expect(body.challenge.method).toBe("tempo");
		expect(body.challenge.intent).toBe("charge");
		expect(body.challenge.realm).toBe(REALM);
		expect(body.challenge.request.amount).toBe("20000");
		expect(typeof body.challenge.id).toBe("string");
	});

	it("POST /v1/joke end-to-end 402 → sign → 200 (with stubbed verify — see docblock)", async () => {
		// Build a parallel app whose mpp is constructed eagerly so we can spy
		// on it. The production worker builds mpp per-request; identical
		// wiring, different lifetime.
		const env = makeEnv();
		const mpp = createPaywrapMpp({
			walletPrivateKey: env.WALLET_PRIVATE_KEY as `0x${string}`,
			mppSecretKey: env.MPP_SECRET_KEY,
			publicBaseUrl: env.PUBLIC_BASE_URL,
			tempoRpcUrl: env.TEMPO_RPC_URL,
			store: workersKvStore(env.PAYWRAP_KV),
		});

		// Synthetic buyer.
		const buyer = privateKeyToAccount(generatePrivateKey());

		type Variables = {
			payer: Hex;
			// biome-ignore lint/suspicious/noExplicitAny: middleware bridge
			verifiedCredential: any;
			// biome-ignore lint/suspicious/noExplicitAny: ctx bridge
			paywrapApp: any;
		};
		const app = new Hono<{ Variables: Variables }>();
		app.use("*", async (c, next) => {
			c.set("paywrapApp", {
				ctx: { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore },
			});
			await next();
		});
		app.post("/v1/joke", mppGated({ scope: "joke:1", amount: 20_000n, intent: "charge" }), (c) =>
			c.json({ joke: randomJoke(), payer: c.var.payer }),
		);

		// Step 1 — buyer asks for the challenge.
		const challengeRes = await app.request("/v1/joke", { method: "POST" });
		expect(challengeRes.status).toBe(402);
		const challengeBody = (await challengeRes.json()) as {
			challenge: {
				id: string;
				realm: string;
				method: string;
				intent: string;
				request: Record<string, unknown>;
				expires?: string;
				opaque?: Record<string, string>;
			};
		};
		expect(challengeBody.challenge.intent).toBe("charge");

		// Step 2 — buyer signs. We produce a real EIP-712 signature tied to a
		// digest of the challenge id — the signature's actual cryptographic
		// content isn't checked by the stubbed verify, but we still exercise
		// real viem signing to keep the test close to reality.
		const proofSignature = await buyer.signMessage({
			message: `paywrap-charge:${challengeBody.challenge.id}`,
		});
		// Mirrors the kit's own usage pattern in
		// `packages/kit/src/signing/index.ts` — `secretKey` passed inline.
		const serverChallenge = Challenge.from({
			realm: challengeBody.challenge.realm,
			method: "tempo",
			intent: "charge",
			expires: challengeBody.challenge.expires ?? Expires.minutes(5),
			request: challengeBody.challenge.request as never,
			meta: challengeBody.challenge.opaque ?? {},
			secretKey: SECRET_KEY,
		});
		const credentialHeader = Credential.serialize(
			Credential.from({
				challenge: serverChallenge,
				payload: { signature: proofSignature, type: "proof" },
				source: `did:pkh:eip155:4217:${buyer.address}`,
			}),
		);

		// Stub the cryptographic + on-chain verify step. Every other check in
		// `verifyWithScope` (scope match via mppx, branded return) still runs.
		vi.spyOn(mpp.mppx, "verifyCredential").mockResolvedValue({
			method: "tempo",
			status: "success",
			timestamp: new Date().toISOString(),
			reference: "stubbed-in-test",
		});

		// Step 3 — buyer retries with the signed credential. Note:
		// `Credential.serialize` already returns a `"Payment <b64>"` string,
		// so the Authorization header value is the serialized output verbatim.
		const res = await app.request("/v1/joke", {
			method: "POST",
			headers: { authorization: credentialHeader },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { joke: string; payer: string };
		expect(typeof body.joke).toBe("string");
		expect(body.joke.length).toBeGreaterThan(0);
		expect(body.payer.toLowerCase()).toBe(buyer.address.toLowerCase());
	});
});
