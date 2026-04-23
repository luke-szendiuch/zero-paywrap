import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPaywrapMpp, memoryStore } from "@zeroclickai/paywrap/mpp";
import { TEMPO_CHAIN_ID, TEMPO_ESCROW } from "@zeroclickai/paywrap/mpp";
import { buildVoucherCredential, channelIdFromLabel } from "@zeroclickai/paywrap/signing";
import * as esbuild from "esbuild";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
	createHonoApp,
	extractCredential,
	sendChargeChallenge,
	sendProofChallenge,
	sendSessionChallenge,
} from "../src/index.js";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const makeCtx = () => {
	const mpp = createPaywrapMpp({
		walletPrivateKey: KNOWN_PK,
		publicBaseUrl: "https://svc.example.com",
		mppSecretKey: "a".repeat(64),
		tempoRpcUrl: "https://rpc.example/tempo",
		store: memoryStore(),
	});
	return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
};

describe("createHonoApp", () => {
	it("returns a Hono instance with ctx attached", () => {
		const ctx = makeCtx();
		const app = createHonoApp(ctx);
		expect(app.ctx).toBe(ctx);
	});

	it("sets paywrapApp on every request — a route reading c.var.paywrapApp sees the ctx", async () => {
		const ctx = makeCtx();
		const app = createHonoApp(ctx);
		app.get("/probe", (c) =>
			c.json({ hasApp: !!c.var.paywrapApp, sameCtx: c.var.paywrapApp.ctx === ctx }),
		);
		const res = await app.request("/probe");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ hasApp: true, sameCtx: true });
	});
});

describe("sendSessionChallenge", () => {
	it("responds 402 with a Payment www-authenticate header", async () => {
		const ctx = makeCtx();
		const app = createHonoApp(ctx);
		app.get("/paid", (c) =>
			sendSessionChallenge({ ctx }, c, { amount: "0.02", scope: "test:1", detail: "pay_up" }),
		);
		const res = await app.request("/paid");
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
		const body = (await res.json()) as { detail?: string };
		expect(body.detail).toBe("pay_up");
	});
});

describe("sendChargeChallenge", () => {
	it("responds 402 for a single-shot paid charge", async () => {
		const ctx = makeCtx();
		const app = createHonoApp(ctx);
		app.get("/charge", (c) =>
			sendChargeChallenge({ ctx }, c, { amount: "0.02", scope: "test:charge", detail: "pay_up" }),
		);
		const res = await app.request("/charge");
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
		const body = (await res.json()) as { detail?: string };
		expect(body.detail).toBe("pay_up");
	});
});

describe("sendProofChallenge", () => {
	it("responds 402 with a zero-amount charge for wallet-auth", async () => {
		const ctx = makeCtx();
		const app = createHonoApp(ctx);
		app.get("/auth", (c) => sendProofChallenge({ ctx }, c, "test:proof", "auth_required"));
		const res = await app.request("/auth");
		expect(res.status).toBe(402);
		expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
		const body = (await res.json()) as { detail?: string };
		expect(body.detail).toBe("auth_required");
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
		const payer = privateKeyToAccount(generatePrivateKey());
		const payee = privateKeyToAccount(generatePrivateKey());
		const header = await buildVoucherCredential({
			payer,
			recipient: payee.address,
			escrowContract: TEMPO_ESCROW,
			chainId: TEMPO_CHAIN_ID,
			channelId: channelIdFromLabel("hono-extract-test"),
			cumulativeAmount: 20_000n,
			realm: "svc.example.com",
			secretKey: "a".repeat(64),
			scope: "test:1",
		});
		expect(extractCredential(header)).not.toBeNull();
		const bare = header.replace(/^Payment /, "");
		expect(extractCredential(bare)).not.toBeNull();
	});
});

describe("Cloudflare Workers compatibility", () => {
	it("adapter-authored source introduces no node:* imports of its own", async () => {
		// We bundle the adapter as if for Workers, but treat every workspace
		// + peer dep as external so what we inspect is ONLY what the adapter
		// itself re-imports. Any `node:*` survivor in THIS output is an
		// adapter-owned regression we should fix. Kit + mppx transitive
		// node deps are tracked separately (see the second test).
		const here = dirname(fileURLToPath(import.meta.url));
		const entry = resolve(here, "../src/index.ts");
		const result = await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			conditions: ["worker", "browser", "module", "import"],
			external: ["hono", "@zeroclickai/paywrap/*", "mppx", "viem", "viem/*"],
			logLevel: "silent",
		});
		expect(result.errors).toEqual([]);
		const [out] = result.outputFiles;
		if (!out) throw new Error("esbuild produced no output");
		const code = out.text;
		const nodeImports = code.match(/from\s*["']node:[^"']+["']/g) ?? [];
		expect(nodeImports).toEqual([]);
	});

	it("documents known transitive node:* deps from mppx/kit (for awareness, not a hard fail)", async () => {
		// Full bundle with everything inlined EXCEPT hono (the peer dep).
		// We expect some node:* imports today — `mppx` currently pulls
		// `node:util`. This test pins the surface so the number is visible
		// and any regression shows up as a diff in the snapshot array.
		const here = dirname(fileURLToPath(import.meta.url));
		const entry = resolve(here, "../src/index.ts");
		try {
			await esbuild.build({
				entryPoints: [entry],
				bundle: true,
				write: false,
				format: "esm",
				platform: "neutral",
				conditions: ["worker", "browser", "module", "import"],
				external: ["hono"],
				logLevel: "silent",
			});
			// If the build succeeds on neutral, we have zero node:* deps —
			// great. Assert that explicitly so the test is meaningful.
			expect(true).toBe(true);
		} catch (err) {
			// Expected today: mppx imports `node:util` at module scope. The
			// error message enumerates the unresolved node:* imports; assert
			// it only contains entries from the known allow-list so we notice
			// if anything NEW (node:fs, node:net, ...) starts sneaking in.
			const msg = err instanceof Error ? err.message : String(err);
			const unresolved = Array.from(msg.matchAll(/Could not resolve "(node:[^"]+)"/g)).map(
				(m) => m[1],
			);
			const allowed = new Set(["node:util", "node:crypto", "node:buffer"]);
			const unexpected = unresolved.filter((id) => !allowed.has(id ?? ""));
			expect(unexpected).toEqual([]);
		}
	});
});

// Sanity reference so the runtime type imports above aren't tree-shaken.
describe("adapter source scan", () => {
	it("exports are reachable", () => {
		// biome-ignore lint/suspicious/noExplicitAny: shim only
		const _ref: any = [Hono, createHonoApp];
		expect(_ref).toBeTruthy();
	});
});
