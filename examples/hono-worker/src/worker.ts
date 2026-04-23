import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { buildPaywrapJson } from "@zeroclickai/paywrap/manifest";
import {
	type MinimalKVNamespace,
	createPaywrapMpp,
	workersKvStore,
} from "@zeroclickai/paywrap/mpp";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomJoke } from "./jokes.js";

/**
 * Worker environment bindings. `PAYWRAP_KV` is declared in `wrangler.toml`;
 * the secrets are set via `wrangler secret put`.
 */
export type Env = {
	PAYWRAP_KV: MinimalKVNamespace;
	WALLET_PRIVATE_KEY: string;
	MPP_SECRET_KEY: string;
	PUBLIC_BASE_URL: string;
	TEMPO_RPC_URL: string;
};

const JOKE_SCOPE = "joke:1" as const;
/** 0.02 USDC in micro-units (USDC = 6 decimals). */
const JOKE_PRICE_MICRO = 20_000n;

/**
 * Build the mpp instance from Worker env bindings. Pulled out of the
 * factory so tests can construct an identical one and install test-only
 * hooks (e.g. `stubVerifyCredential`) before making a request.
 */
export const mppFromEnv = (env: Env): ReturnType<typeof createPaywrapMpp> =>
	createPaywrapMpp({
		walletPrivateKey: env.WALLET_PRIVATE_KEY as `0x${string}`,
		mppSecretKey: env.MPP_SECRET_KEY,
		publicBaseUrl: env.PUBLIC_BASE_URL,
		tempoRpcUrl: env.TEMPO_RPC_URL,
		store: workersKvStore(env.PAYWRAP_KV),
	});

export type BuildAppOptions = {
	/** Testing-only: pre-built mpp so tests can install hooks (e.g. `stubVerifyCredential`). */
	mpp?: ReturnType<typeof createPaywrapMpp>;
};

export const buildApp = (options: BuildAppOptions = {}) => {
	// Factory ctx: Worker env bindings are only available per-request (via
	// `c.env`), so the mpp instance is built per request in production.
	const app = createHonoApp<{
		mppx: ReturnType<typeof createPaywrapMpp>["mppx"];
		mppxChannelStore: ReturnType<typeof createPaywrapMpp>["channelStore"];
	}>((c) => {
		const mpp = options.mpp ?? mppFromEnv(c.env as Env);
		return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
	});

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	app.get("/.well-known/paywrap.json", (c) => {
		const env = c.env as Env;
		const wallet = privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`).address as Address;
		const manifest = buildPaywrapJson({
			wallet,
			paidRoutes: [
				{
					method: "POST",
					path: "/v1/joke",
					protocol: "mpp",
					sku: "joke:1",
					priceUsdcMicro: JOKE_PRICE_MICRO.toString(),
					pricingVersion: 1,
					description: "Return one random joke. Charged per request.",
				},
			],
			freeRoutes: [
				{ method: "GET", path: "/healthz", description: "Liveness probe." },
				{
					method: "GET",
					path: "/.well-known/paywrap.json",
					description: "Service discovery manifest.",
				},
			],
		});
		return c.json(manifest);
	});

	app.post(
		"/v1/joke",
		mppGated({
			scope: JOKE_SCOPE,
			amount: JOKE_PRICE_MICRO,
			intent: "charge",
		}),
		(c) => c.json({ joke: randomJoke(), payer: c.var.payer }),
	);

	return app;
};

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => buildApp().fetch(request, env, ctx),
};
