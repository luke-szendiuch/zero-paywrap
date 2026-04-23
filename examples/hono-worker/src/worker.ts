import { type PaywrapBindings, mppGated } from "@zerorun/paywrap-adapter-hono";
import { buildPaywrapJson } from "@zerorun/paywrap/manifest";
import { type MinimalKVNamespace, createPaywrapMpp, workersKvStore } from "@zerorun/paywrap/mpp";
import { Hono } from "hono";
import type { Address } from "viem";
import { randomJoke } from "./jokes.js";

type Variables = PaywrapBindings & { walletAddress: Address };

/**
 * Worker environment bindings. `PAYWRAP_KV` is the namespace declared in
 * `wrangler.toml`. `WALLET_PRIVATE_KEY` + `MPP_SECRET_KEY` are secrets set
 * via `wrangler secret put`.
 */
export type Env = {
	PAYWRAP_KV: MinimalKVNamespace;
	WALLET_PRIVATE_KEY: string;
	MPP_SECRET_KEY: string;
	PUBLIC_BASE_URL: string;
	TEMPO_RPC_URL: string;
};

/** Scope + price for the paid route. Surfaced in `.well-known/paywrap.json`. */
const JOKE_SCOPE = "joke:1" as const;
/** 0.02 USDC in micro-units (USDC has 6 decimals). */
const JOKE_PRICE_MICRO = 20_000n;

export const buildApp = () => {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();

	// Per-request wiring. We build `mpp` inside each request because Worker
	// env bindings (KV, secrets) are only available via `c.env`. Constructing
	// `createPaywrapMpp` is cheap (a viem wallet client + mppx config).
	app.use("*", async (c, next) => {
		const mpp = createPaywrapMpp({
			walletPrivateKey: c.env.WALLET_PRIVATE_KEY as `0x${string}`,
			mppSecretKey: c.env.MPP_SECRET_KEY,
			publicBaseUrl: c.env.PUBLIC_BASE_URL,
			tempoRpcUrl: c.env.TEMPO_RPC_URL,
			store: workersKvStore(c.env.PAYWRAP_KV),
		});
		c.set("paywrapApp", {
			ctx: { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore },
		});
		// Stash the wallet address for the manifest handler. The seller's
		// payout wallet is derived from the private key.
		c.set("walletAddress", mpp.account.address);
		await next();
	});

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	app.get("/.well-known/paywrap.json", (c) => {
		// Pull walletAddress set in the middleware above. `as string` is safe
		// because the middleware runs on every request before this handler.
		const wallet = c.var.walletAddress;
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
