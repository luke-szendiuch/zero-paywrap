/**
 * Integration test for the /v1/joke Hono Worker.
 *
 * Boots the Worker's exact `buildApp()` via Hono's built-in `app.request()`
 * harness (no miniflare needed). Provides a fake KV via an in-memory Map
 * that satisfies the `MinimalKVNamespace` interface the kit exposes.
 *
 * End-to-end: 402 → sign via `buildChargeCredential` → 200. Because the
 * paid-charge path settles on-chain (real Tempo RPC + funded wallet), we
 * pair with `stubVerifyCredential` to bypass settlement — every other
 * adapter + kit code path (header parse, extractCredential, scope wiring,
 * payer resolution via `did:pkh`, handler invocation, response shape,
 * Workers KV interaction) runs for real.
 */

import type { MinimalKVNamespace } from "@zerorun/paywrap/mpp";
import { buildChargeCredential } from "@zerorun/paywrap/signing";
import { stubVerifyCredential } from "@zerorun/paywrap/testing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { type Env, buildApp, mppFromEnv } from "../src/worker.js";

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
	let restore: (() => void) | undefined;
	afterEach(() => {
		restore?.();
		restore = undefined;
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

	it("POST /v1/joke end-to-end 402 → sign → 200 (with stubVerifyCredential)", async () => {
		const env = makeEnv();
		const buyer = privateKeyToAccount(generatePrivateKey());

		// Build the mpp up-front and inject it into the app so the same
		// instance both handles the request AND carries the stub. `mppx.verifyCredential`
		// is an instance-owned function (see mppx/dist/server/Mppx.js), so
		// the stub only reaches the request path through this injection.
		const mpp = mppFromEnv(env);
		({ restore } = stubVerifyCredential(mpp.mppx));
		const app = buildApp({ mpp });

		const authz = await buildChargeCredential({
			payer: buyer,
			recipient: mpp.account.address,
			amountMicro: 20_000n,
			realm: REALM,
			secretKey: SECRET_KEY,
			scope: "joke:1",
		});

		const res = await app.request(
			"/v1/joke",
			{ method: "POST", headers: { authorization: authz } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { joke: string; payer: string };
		expect(typeof body.joke).toBe("string");
		expect(body.joke.length).toBeGreaterThan(0);
		expect(body.payer.toLowerCase()).toBe(buyer.address.toLowerCase());
	});
});
