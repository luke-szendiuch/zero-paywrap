# @zeroclickai/paywrap

Framework-agnostic primitives for building **agent-callable paid APIs** over HTTP. Gate routes with **MPP** (session + charge intents on Tempo, USDC settlement) or **x402** (facilitator-mediated USDC settlement on Base / Base Sepolia), publish OpenAPI payment metadata, verify payment credentials, and emit structured settlement logs. Each protocol lives behind its own subpath — pick one or run both side-by-side per route.

**Two ways in:**
1. **Already have an API?** `pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-fastify` or `@zeroclickai/paywrap-adapter-hono` — 10 lines of middleware to gate any route (see Path A below).
2. **Starting fresh?** `npx @zeroclickai/paywrap-cli create my-service` — interactive scaffold with routes, env schema, Dockerfile, optional DB + worker (see Path B below). Nothing to install up-front.

The kit is intentionally narrow — everything here is runnable from any Node HTTP framework. For Fastify, layer [`@zeroclickai/paywrap-adapter-fastify`](../adapters/fastify/) on top; for Hono / Workers / Bun, use [`@zeroclickai/paywrap-adapter-hono`](../adapters/hono/). The CLI is a separate package so runtime services don't carry scaffolder deps.

Building your first paid API? Start with the [Service Builder Guide](./docs/service-builder-guide.md). It is the canonical walkthrough for choosing between charge-based, session-based, metered, and charge-plus-proof services.

## Documentation

Use the npm page as a fast front door, then jump into the page that matches the work in front of you:

| Page | Use it when... |
|---|---|
| [Service Builder Guide](./docs/service-builder-guide.md) | You are designing a new paid service or deciding which payment model fits. |
| [List Your Service On Zero](./docs/list-on-zero.md) | You are ready to register a deployed service with Zero's `/v1/register` endpoint. |
| [Package Reference](./docs/package-reference.md) | You need the import map, companion packages, and manifest/OpenAPI helpers. |
| [Operations Guide](./docs/operations.md) | You are preparing a service for production logging, validation, refunds, and smoke tests. |

## Two quickstart paths

Both paths are first-class. Pick the one that matches your starting point.

### Path A — Drop-in to an existing Fastify API

*"I already have a service and want to MPP-gate one or more endpoints."*

```bash
pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-fastify
```

Stand up mppx, wire it onto a fastify instance, and gate any route with the `app.mppGated(...)` preHandler:

```ts
import Fastify from "fastify";
import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";
import { createFastifyApp } from "@zeroclickai/paywrap-adapter-fastify";
import { consoleJsonLogger } from "@zeroclickai/paywrap/logger";

// Default mode: pass `walletAddress` only — buyer signs and pays gas, so
// the seller never holds a private key. Use `walletPrivateKey` for
// session-intent or `feePayer: true` charge (see callout below).
const mpp = createPaywrapMpp({
	walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
	mppSecretKey: process.env.MPP_SECRET_KEY!,
	publicBaseUrl: process.env.PUBLIC_BASE_URL!,
	tempoRpcUrl: "https://rpc.tempo.xyz",
	logger: consoleJsonLogger, // structured payment_required/settled/failed events on stdout
	// `store` omitted → in-memory by default when REDIS_URL is unset.
});

// Your existing ctx — typically env, logger, db, services. The adapter only
// needs `logger` + `mppx` + `mppxChannelStore` for mppGated to work.
const app = createFastifyApp({
	logger: yourPinoInstance,
	mppx: mpp.mppx,
	mppxChannelStore: mpp.channelStore,
});

app.post(
	"/generate",
	{ preHandler: app.mppGated({ scope: "gen:1", amount: 50_000n, intent: "charge" }) },
	async (req) => {
		// req.payer is typed Hex; req.verifiedCredential is the branded VerifiedCredential.
		const result = await yourBusinessLogic(req.body, req.payer);
		return { result };
	},
);

await app.listen({ port: 3000 });
```

> **No Redis required for dev.** paywrap uses an in-memory channel store when `REDIS_URL` is unset. Add Redis before scaling to multiple replicas — see [`@zeroclickai/paywrap/mpp`'s `redisStore`](../../packages/kit/src/mpp/stores.ts). On Cloudflare Workers, use [`workersKvStore`](./src/mpp/stores/workers-kv.ts) (charge-safe; non-atomic for high-concurrency session — read the docblock).

> **Wallet bootstrap.** Who pays gas depends on the intent:
> - **`charge` intent** — buyer pays gas. The buyer signs a Tempo tx with `feeToken: USDC`, the seller broadcasts it as-is. Seller wallet needs NO funding; it's just a signer (for HMAC-bound challenges) + settlement recipient.
> - **`session` intent** — seller pays gas. The seller submits `openChannel`/`closeChannel` txs and needs USDC to cover those. Use `paywrap prefund` to seed ~$0.05.
> - **`proof` intent** — zero-amount wallet-auth; no on-chain activity, no funding.
>
> Opting into `feePayer: true` on charge sponsors the buyer's gas — then the seller pays. mppx's default is no fee-payer. The [`paywrap`](../cli/) CLI provides `paywrap generate-wallet` + `paywrap prefund`.

> **Default mode is keyless — pass a `walletAddress`.** For charge-intent and proof-intent services (the common case for stateless paid APIs) the seller never needs a private key in the runtime. `createPaywrapMpp({ walletAddress })` returns the basic `PaywrapMpp` shape: `{ mppx, channelStore, walletAddress }`. No signing material is provisioned, rotated, or accidentally logged.
> ```ts
> import { createPaywrapMpp, type PaywrapMpp } from "@zeroclickai/paywrap/mpp";
>
> const mpp: PaywrapMpp = createPaywrapMpp({
>   walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,  // public address only
>   mppSecretKey: process.env.MPP_SECRET_KEY!,
>   publicBaseUrl: process.env.PUBLIC_BASE_URL!,
>   tempoRpcUrl: "https://rpc.tempo.xyz",
> });
> ```
> Pass `walletPrivateKey` instead when you need a signer: session intent (server-side `openChannel`/`closeChannel` writes), session settle helpers like `closeSessionOnChain`, metered close helpers, or `feePayer: true` charge variants. That returns `PaywrapMppKeyed`, which structurally extends `PaywrapMpp` with `account` + `client` — so anywhere that takes `PaywrapMpp` also accepts a keyed bundle, but helpers that need a signer (e.g. `closeSessionOnChain(mpp: PaywrapMppKeyed)`) reject the keyless variant at the type level. The config is discriminated: passing both is a compile error. Calling `mppGated({ intent: "session", ... })` against a keyless `mppx` fails verification with a clear error — there is no session method registered.

First-pass curl against a paid route:

```sh
# 1. Buyer hits the endpoint with no payment header.
curl -X POST "https://api.example.com/generate" -i

# HTTP/1.1 402 Payment Required
# www-authenticate: Payment eyJyZWFsbSI6ImFwaS5leGFtcGxlLmNvbSIs...
# {"challenge":{...},"detail":"payment_required"}

# 2. Buyer signs the challenge (the `zero` CLI does this transparently)
#    and retries with Authorization: Payment <credential>.
curl -X POST "https://api.example.com/generate" \
  -H "Authorization: Payment eyJjaGFsbGVuZ2UiOnsiLi4uIjp9fQ=="

# HTTP/1.1 200 OK
# {"result":"..."}
```

> **Authorization header is ready-to-send.** `buildVoucherCredential` and
> `buildChargeCredential` (from `@zeroclickai/paywrap/signing`) return the FULL
> Authorization header value, including the `Payment ` prefix. Pass it as-is:
> `fetch(url, { headers: { authorization: await buildChargeCredential(...) } })`.
> Do not wrap it in another `"Payment "`.

### Path A2 — Drop-in to an existing Hono / Workers API

*"I already have a Worker or Hono service and want route-level gates."*

```bash
pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-hono
```

Workers bindings only exist per request, so build the paywrap ctx inside the `createHonoApp` factory:

```ts
import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { buildOpenApiSpec } from "@zeroclickai/paywrap/manifest";
import { createPaywrapMpp, workersKvStore } from "@zeroclickai/paywrap/mpp";

type Env = {
	PAYWRAP_KV: KVNamespace;
	WALLET_ADDRESS: string;
	MPP_SECRET_KEY: string;
	PUBLIC_BASE_URL: string;
	TEMPO_RPC_URL: string;
	SKU_PRICE_USDC_MICRO: string;
};

const SKU = "diagram-render:v1";
const PRICING_VERSION = 1;
const SCOPE = `${SKU}:${PRICING_VERSION}`;

const app = createHonoApp<{ Bindings: Env }>((c) => {
	// Cast the env string to viem's branded Hex once. Env bindings are
	// always `string`; `createPaywrapMpp` wants `0x${string}`.
	const walletAddress = c.env.WALLET_ADDRESS as `0x${string}`;
	const mpp = createPaywrapMpp({
		walletAddress,
		mppSecretKey: c.env.MPP_SECRET_KEY,
		publicBaseUrl: c.env.PUBLIC_BASE_URL,
		tempoRpcUrl: c.env.TEMPO_RPC_URL,
		store: workersKvStore(c.env.PAYWRAP_KV),
	});
	return {
		mppx: mpp.mppx,
		mppxChannelStore: mpp.channelStore,
		walletAddress: mpp.walletAddress, // canonical — present in both keyed and address-only modes
		priceUsdcMicro: BigInt(c.env.SKU_PRICE_USDC_MICRO),
	};
});

const buildManifest = (ctx) => ({
	wallet: ctx.walletAddress,
	paidRoutes: [
		{
			method: "POST" as const,
			path: "/v1/render",
			protocol: "mpp" as const,
			sku: SKU,
			priceUsdcMicro: ctx.priceUsdcMicro.toString(),
			pricingVersion: PRICING_VERSION,
			description: "Render a diagram and return SVG bytes.",
			requestContentType: "application/json",
			responseContentType: "image/svg+xml",
		},
	],
	freeRoutes: [{ method: "GET" as const, path: "/healthz" }],
});

// `/openapi.json` is the public discovery contract — paired with real `402`
// responses on paid routes, it tells indexers and agents exactly what this
// service costs and how to call it.
app.get("/openapi.json", (c) => {
	const ctx = c.get("paywrapApp").ctx;
	return c.json(
		buildOpenApiSpec(
			buildManifest(ctx),
			{ title: "Diagram Service", version: "1.0.0" },
			{ serverUrl: c.env.PUBLIC_BASE_URL },
		),
	);
});

app.post(
	"/v1/render",
	async (c, next) => {
		const ctx = c.get("paywrapApp").ctx;
		const gate = mppGated({
			scope: SCOPE,
			intent: "charge",
			amount: ctx.priceUsdcMicro,
			meta: { sku: SKU, pricingVersion: String(PRICING_VERSION) },
			preCheck: async ({ c }) => {
				const body = await c.req.json().catch(() => null);
				if (!body || typeof body.diagram !== "string") {
					return { ok: false, status: 400, body: { error: "invalid_body" } };
				}
				c.set("renderBody" as never, body as never);
				return { ok: true };
			},
		});
		// Hono's middleware type can't see the extra paywrapApp binding here.
		return gate(c as never, next);
	},
	async (c) => {
		const body = c.get("renderBody" as never) as { diagram: string };
		const result = await renderDiagram(body.diagram, c.var.payer);
		return c.body(result.svg, 200, { "content-type": "image/svg+xml" });
	},
);

export default { fetch: app.fetch };
```

This is the same route-level gate as Fastify, with Worker-safe state. Use `workersKvStore` for charge-intent replay protection; for Node/Bun services use `redisStore(...)` or the default in-memory store for local dev.

### Path B — Start from scratch with the CLI

*"I don't have a service yet; I want the full scaffold."*

```bash
npx @zeroclickai/paywrap-cli create my-service
cd my-service
pnpm dev
```

The CLI walks through:

- **intent** — `session` (channel vouchers, extend semantics), `charge` (atomic single-shot), or `proof` (wallet-auth only).
- **price + scope** — micro-USDC price per call; HMAC-bound scope string.
- **framework + storage + queue + hosting** — fastify, postgres/sqlite/redis, bullmq/none, render/fly/self-host.
- **wallet** — generates a fresh private key inline, prints the address + private key once.
- **prefund** — session intent only; tops up the seller wallet with ~$0.05 USDC on Tempo so `openChannel`/`closeChannel` can pay gas. Charge and proof services skip this (buyer-paid gas / zero on-chain).

Post-scaffold you have a working 402 paid endpoint in under 3 minutes. Business logic lives behind `TODO(paywrap)` markers — everything surrounding it (challenge minting, verification, payer resolution, manifest, healthz) is already wired.

Path B is right when you want the full service (DB + worker + reaper + manifest). Path A is right when you already have an API and just want to charge for it.

## Subpaths

The kit ships **no root barrel** — import only the subpath you need. This keeps your bundle tight and the dependency graph honest.

| Subpath | Exports | Reach for it when… |
|---|---|---|
| `@zeroclickai/paywrap/mpp` | `createPaywrapMpp`, `memoryStore`, `redisStore`, `workersKvStore`, `closeSessionOnChain`, `verifyWithScope`, `assertVoucherAdvances`, `TEMPO_ESCROW`, `TEMPO_USDC`, `TEMPO_CHAIN_ID`, `tempoChain` | Bootstrapping mppx, choosing a channel-state store (in-memory / Redis / Workers KV), verifying credentials at route handlers, closing channels on-chain. |
| `@zeroclickai/paywrap/mpp/metered` | metered-settlement helpers | Helpers for metered (max-authorized, actual-usage) settlement flows. Pair with `mppMetered` from the Hono adapter for routes whose final price is only known after the handler runs. |
| `@zeroclickai/paywrap/x402` | `createPaywrapX402`, `BASE_NETWORK`, `BASE_SEPOLIA_NETWORK`, `BASE_USDC`, `BASE_SEPOLIA_USDC`, `x402NetworkId`, `x402UsdcAsset` | Bootstrapping the seller-side x402 resource server (Base / Base Sepolia, exact-evm, USDC). Pair with the hono adapter's `x402Gated()` to gate routes. Settlement runs through the configured x402 facilitator (defaults to `https://x402.org/facilitator`). |
| `@zeroclickai/paywrap/auth` | `buildSessionChallenge`, `buildChargeChallenge`, `buildProofChallenge`, `payerFromCredential`, `fingerprintCredential`, `VerifiedCredential`, `VERIFIED` (brand symbol) | Minting 402 challenges from any framework, resolving the authenticated payer address from a verified credential, computing a stable idempotency key from a `Payment …` header. |
| `@zeroclickai/paywrap/signing` | `signVoucher`, `buildVoucherCredential`, `buildChargeCredential`, `channelIdFromLabel` | Buyer-side code (CLI, agent) producing signed Tempo vouchers / charge credentials. Useful in integration tests too. |
| `@zeroclickai/paywrap/testing` | `seedChannel`, `stubVerifyCredential` | Seeding a `ChannelStore` with a fake-open channel in tests; stubbing `mppx.verifyCredential` to skip on-chain settlement. Not for production. |
| `@zeroclickai/paywrap/crypto` | `encryptSecret`, `decryptSecret`, AES-256-GCM helpers | At-rest encryption of upstream credentials (connection strings, API tokens) stored in your DB. |
| `@zeroclickai/paywrap/manifest` | `buildOpenApiSpec`, `buildPaywrapJson` | Keeping route pricing in one typed manifest and emitting OpenAPI with `x-payment-info` + `402` responses. **`buildOpenApiSpec` is the public discovery contract — serve it at `/openapi.json`.** `buildPaywrapJson` is internal/legacy for Paywrap-specific tooling only; not part of the public contract. |
| `@zeroclickai/paywrap/health` | `aggregateHealthProbes` | Assembling `/healthz` responses from per-subsystem probes. |
| `@zeroclickai/paywrap/setup` | `generateWallet`, `generateMppSecretKey`, `prefundWallet` | One-shot setup scripts the CLI wraps; callable from a consumer's own `pnpm setup`. |
| `@zeroclickai/paywrap/proxy` | `proxyUpstreamRequest`, `UpstreamProxyResponse` | Charge-intent services proxying an upstream API. Sniffs Content-Type and returns a discriminated `{kind: "json" \| "binary"}` so PNG/PDF endpoints don't get JSON-corrupted. |
| `@zeroclickai/paywrap/logger` | `LoggerCallback`, `PaywrapLogEvent`, `consoleJsonLogger`, `safeLog`, `shortFingerprint` | Structured-event logging hook. Pass a `logger` to `createPaywrapMpp` / `createPaywrapX402` and adapters emit `payment_required`, `payment_settled`, `payment_failed`, and `request_completed`. Sink-agnostic — see "Observability" below. |

## Service discovery: OpenAPI + 402

`/openapi.json` is the public discovery surface, paired with real `402 Payment Required` responses from paid routes. Generate it with `buildOpenApiSpec` from `@zeroclickai/paywrap/manifest`: paid operations get `x-payment-info` (`method`, `currency`, `amount`, `sku`, `pricingVersion`) plus a `402` response, and the live route returns the actual payment challenge header when called without a credential. Together those two surfaces are the entire contract — indexers and agents do not need anything else to discover or call your service.

`buildPaywrapJson` is shipped from the same subpath as an internal/legacy helper for Paywrap-specific tooling. It is **not** part of the public discovery contract; do not advertise `/.well-known/paywrap.json` to external consumers.

```ts
import { buildOpenApiSpec } from "@zeroclickai/paywrap/manifest";

const buildManifest = (ctx) => ({
	wallet: ctx.walletAddress,
	paidRoutes: [
		{
			method: "POST",
			path: "/v1/render",
			protocol: "mpp",
			sku: "mermaid-render:v1",
			priceUsdcMicro: "1000",
			pricingVersion: 1,
			description: "Render Mermaid diagram text to SVG, PNG, JPEG, WebP, or PDF bytes.",
			requestContentType: "application/json",
			responseContentType: "image/svg+xml",
		},
	],
	freeRoutes: [
		{ method: "GET", path: "/openapi.json" },
		{ method: "GET", path: "/healthz" },
	],
});

app.get("/openapi.json", (c) =>
	c.json(
		buildOpenApiSpec(
			buildManifest(ctx),
			{ title: "My Service", version: "1.0", description: "What it does." },
			{ serverUrl: ctx.env.PUBLIC_BASE_URL },
		),
	),
);
```

`buildOpenApiSpec` emits one operation per route. Paid operations include `x-payment-info` (`method`, `currency`, `amount`, `sku`, `pricingVersion`) and a `402` response. `sku` is seller-defined and should change when the priced unit changes. `pricingVersion` lets buyers bind a credential to a specific price contract without encoding every version detail into the path.

## Validate before charging

For charge-intent routes, `mppGated` verifies and settles before your handler runs. Use `preCheck` for business validation that must happen before the buyer pays: malformed JSON, name collisions, unsupported enum values, quota checks, idempotent retries, and other cheap local checks.

```ts
app.post(
	"/v1/things",
	mppGated({
		scope: "thing-create:v1",
		intent: "charge",
		amount: 50_000n,
		preCheck: async ({ c, claimedPayer }) => {
			const body = await c.req.json().catch(() => null);
			if (!body || typeof body.name !== "string") {
				return { ok: false, status: 400, body: { error: "invalid_body" } };
			}
			if (await nameAlreadyExists(body.name, claimedPayer)) {
				return { ok: false, status: 409, body: { error: "name_taken" } };
			}
			c.set("thingInput" as never, body as never);
			return { ok: true };
		},
	}),
	async (c) => {
		const body = c.get("thingInput" as never);
		return c.json(await createThing(body, c.var.payer), 201);
	},
);
```

`claimedPayer` is only a hint extracted before verification. Use it for reads and routing decisions, never for irreversible writes. The adapter emits `payment_failed` with `stage: "precheck"` if your pre-check throws.

### Dynamic pricing

If price comes from env, tenant config, or a route table, build the gate inside a small middleware so the `amount` in the challenge matches the manifest and runtime config.

```ts
app.post(
	"/v1/render",
	async (c, next) => {
		const price = BigInt(c.env.SKU_PRICE_USDC_MICRO);
		const gate = mppGated({
			scope: "render:v1",
			intent: "charge",
			amount: price,
			meta: { sku: "render:v1", pricingVersion: "1" },
		});
		return gate(c as never, next);
	},
	async (c) => c.json({ ok: true }),
);
```

### Refund-eligible failures: just log this shape

When charge-intent settles and the upstream call fails, the buyer paid for nothing. Refunds happen out-of-band by an operator script. The kit doesn't ship a wrapper — just emit one JSON line per failure with this shape, on `console.error`:

```ts
console.error(JSON.stringify({
  msg: "paywrap_refund_owed",
  payer: "0xabc",
  sku: "jigsaw-image-gen:v2",
  amountUsdcMicro: "50000",
  reason: "upstream_5xx",
  details: { upstreamStatus: 503 },
  chargeHash: "ff00",
  timestamp: new Date().toISOString(),
}));
```

Standard shape across services means one operator grep handles every paywrap deployment.

Use this for post-settlement failures you would not intentionally bill for: upstream 5xx, upstream rate limits, network timeouts, worker crashes after settlement, and validation you could only do after the paid side effect began. Do not log refunds for `preCheck` rejections because those happen before settlement. For upstream/user 4xx, decide per product: if the user paid for validation or linting, return the 4xx as the paid result; if the upstream rejected a request your service should have caught before settlement, log the refund event.

Include `chargeHash` or a credential fingerprint when your route already computes one for idempotency. Never log the raw `Payment ...` header.

## Observability

Pass a `logger` to either factory and the kit emits structured events at every interesting moment of a paid request — `payment_required`, `payment_settled`, `payment_failed`, `request_completed`. The kit is sink-agnostic: pick a destination that fits your runtime.

### Default: stdout JSON

```ts
import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";
import { consoleJsonLogger } from "@zeroclickai/paywrap/logger";

const mpp = createPaywrapMpp({
  walletPrivateKey: env.WALLET_PRIVATE_KEY,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  mppSecretKey: env.MPP_SECRET_KEY,
  tempoRpcUrl: env.TEMPO_RPC_URL,
  logger: consoleJsonLogger, // ← one JSON line per event on stdout
});
```

This works everywhere `console.log` does — captured by `wrangler tail` (Workers), Render's log viewer, `journalctl`, etc.

### Cloudflare Workers + Analytics Engine

```ts
import { createPaywrapX402 } from "@zeroclickai/paywrap/x402";
import type { LoggerCallback } from "@zeroclickai/paywrap/logger";

const aeLogger: LoggerCallback = (event) => {
  c.env.PAYMENTS_AE.writeDataPoint({
    indexes: [event.kind === "payment_settled" ? event.payer : ""],
    blobs: [event.kind, event.protocol ?? "", JSON.stringify(event)],
    doubles: [
      event.kind === "payment_settled" ? Number(event.amountUsdcMicro) / 1e6 : 0,
      event.kind === "request_completed" ? event.latencyMs : 0,
    ],
  });
};

const x402 = createPaywrapX402({ payTo, network: "base", logger: aeLogger });
```

Workers Analytics Engine is free up to 25M data points/month and queryable via the Workers Analytics SQL API.

### Render / Node + Datadog

```ts
import type { LoggerCallback } from "@zeroclickai/paywrap/logger";

const ddLogger: LoggerCallback = async (event) => {
  // Don't await this in the hot path — fire-and-forget on Workers, or
  // wrap with `c.executionCtx.waitUntil(...)` if you need delivery
  // guarantees.
  fetch("https://http-intake.logs.datadoghq.com/api/v2/logs", {
    method: "POST",
    headers: { "DD-API-KEY": process.env.DD_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ ...event, ddsource: "paywrap", service: "my-service" }),
  }).catch(() => {});
};
```

For Render specifically, `consoleJsonLogger` plus a configured **Log Stream** in the Render dashboard forwards everything to Logtail / Datadog / Papertrail without code changes.

### What's in each event

```ts
type PaywrapLogEvent =
  | { v: 1; kind: "payment_required"; protocol: "mpp" | "x402"; route, scope, intent?, amountUsdcMicro?, meta? }
  | { v: 1; kind: "payment_settled";  protocol: "mpp" | "x402"; payer, seller, amountUsdcMicro, route, scope?, sku?, latencyMs, txHash?, network?, sessionId?, credentialFingerprint? }
  | { v: 1; kind: "payment_failed";   protocol: "mpp" | "x402"; stage: "verify" | "settle" | "precheck" | "unknown"; reason, scope?, route? }
  | { v: 1; kind: "request_completed"; route, status, latencyMs, payer? };
```

Schema is versioned (`v: 1`) so dashboards can pin to a known shape.

### Privacy invariants enforced by the kit

- The raw `Payment …` Authorization header **never** appears in any event. Only the first 16 hex chars of `fingerprintCredential(rawHeader)` are surfaced (as `credentialFingerprint`).
- No private keys, no signatures. Payer addresses are public on-chain so they're fine to log.

### Logger errors are never your problem

Adapters call your logger through `safeLog`, which swallows synchronous throws and async rejections. A flaky sink (Datadog 5xx, network blip) cannot break a paid call. If your logger silently no-ops, the kit logs nothing — but the request still settles correctly.

### x402 settle events come "for free"

For x402, the kit registers `onAfterSettle` / `onSettleFailure` hooks on the underlying `x402ResourceServer` inside `createPaywrapX402`. That means `payment_settled` events include the on-chain `txHash` and verified `payer` address from the facilitator response — no glue code needed in your service.

## Manual route pattern (when you can't use `mppGated`)

`app.mppGated(...)` fits most paid routes, but sometimes you need to run business validation *before* settling — e.g. a `POST /deploys` endpoint that must reject a name collision without charging. For those cases, drop the preHandler and do the three-step pattern by hand:

```ts
import { extractCredential, sendSessionChallenge } from "@zeroclickai/paywrap-adapter-fastify";
import { payerFromCredential } from "@zeroclickai/paywrap/auth";
import { verifyWithScope } from "@zeroclickai/paywrap/mpp";

app.post("/v1/things", async (req, reply) => {
	const header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
	const credential = extractCredential(header);
	if (!credential) {
		return sendSessionChallenge(app, reply, {
			amount: "0.02", suggestedDeposit: "0.02", unitType: "request",
			scope: "my-svc:1", detail: "payment_required",
		});
	}

	// ... business pre-checks that must NOT consume a charge ...

	// verifyWithScope is the ONLY factory for VerifiedCredential — forget the
	// scope check and TypeScript rejects any downstream call.
	const verified = await verifyWithScope(app.ctx.mppx, credential, "my-svc:1");
	const payer = await payerFromCredential(app.ctx.mppxChannelStore, verified);
	if (!payer) return reply.status(500).send({ error: "channel_state_missing" });

	// ... create your resource, return 202 ...
});
```

## Security contract

`verifyWithScope` is the **only** factory that produces a `VerifiedCredential`. The branded type uses a module-private symbol, so no caller can forge the verified shape to hand to `payerFromCredential` without actually running the scope check. This closes a class of footguns where a route forgets to check the credential's scope and accepts a cross-route replay.

HMAC-bound challenge ids + scope enforcement are load-bearing: the kit enforces them at the type level.

## Related packages

- [`@zeroclickai/paywrap-adapter-fastify`](../adapters/fastify/) — Fastify adapter: `app.mppGated(...)`, `sendSessionChallenge`, `sendChargeChallenge`, `sendProofChallenge`, `extractCredential`, `createFastifyApp`.
- [`@zeroclickai/paywrap-adapter-hono`](../adapters/hono/) — Hono / Workers / Bun adapter: `createHonoApp(...)`, `mppGated(...)`, `x402Gated(...)`, challenge helpers, Worker KV state examples.
- [`@zeroclickai/paywrap-cli`](../cli/) (bin: `paywrap`) — interactive scaffolder (`paywrap create`), wallet generator.
