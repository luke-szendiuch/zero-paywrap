# @zeroclickai/paywrap

Framework-agnostic primitives for building **paid API services** that speak payment protocols over HTTP. Today the kit covers **MPP** (session + charge intents on Tempo, USDC settlement); **x402** is the next protocol we're slotting in alongside without breaking consumers.

**Two ways in:**
1. **Already have an API?** `pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-fastify` — 10 lines of middleware to gate any route (see Path A below).
2. **Starting fresh?** `npx @zeroclickai/paywrap-cli create my-service` — interactive scaffold with routes, env schema, Dockerfile, optional DB + worker (see Path B below). Nothing to install up-front.

The kit is intentionally narrow — everything here is runnable from any Node HTTP framework. For Fastify, layer [`@zeroclickai/paywrap-adapter-fastify`](../adapters/fastify/) on top; for Hono / Workers / Bun, use [`@zeroclickai/paywrap-adapter-hono`](../adapters/hono/). The CLI is a separate package so runtime services don't carry scaffolder deps.

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

const mpp = createPaywrapMpp({
	walletPrivateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
	mppSecretKey: process.env.MPP_SECRET_KEY!,
	publicBaseUrl: process.env.PUBLIC_BASE_URL!,
	tempoRpcUrl: "https://rpc.tempo.xyz",
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
| `@zeroclickai/paywrap/auth` | `buildSessionChallenge`, `buildChargeChallenge`, `buildProofChallenge`, `payerFromCredential`, `fingerprintCredential`, `VerifiedCredential`, `VERIFIED` (brand symbol) | Minting 402 challenges from any framework, resolving the authenticated payer address from a verified credential, computing a stable idempotency key from a `Payment …` header. |
| `@zeroclickai/paywrap/signing` | `signVoucher`, `buildVoucherCredential`, `buildChargeCredential`, `channelIdFromLabel` | Buyer-side code (CLI, agent) producing signed Tempo vouchers / charge credentials. Useful in integration tests too. |
| `@zeroclickai/paywrap/testing` | `seedChannel`, `stubVerifyCredential` | Seeding a `ChannelStore` with a fake-open channel in tests; stubbing `mppx.verifyCredential` to skip on-chain settlement. Not for production. |
| `@zeroclickai/paywrap/crypto` | `encryptSecret`, `decryptSecret`, AES-256-GCM helpers | At-rest encryption of upstream credentials (connection strings, API tokens) stored in your DB. |
| `@zeroclickai/paywrap/manifest` | `buildPaywrapJson` | Serving `/.well-known/paywrap.json` — the service manifest indexers + agents use to learn your pricing. |
| `@zeroclickai/paywrap/health` | `aggregateHealthProbes` | Assembling `/healthz` responses from per-subsystem probes. |
| `@zeroclickai/paywrap/setup` | `generateWallet`, `generateMppSecretKey`, `prefundWallet` | One-shot setup scripts the CLI wraps; callable from a consumer's own `pnpm setup`. |
| `@zeroclickai/paywrap/proxy` | `proxyUpstreamRequest`, `UpstreamProxyResponse` | Charge-intent services proxying an upstream API. Sniffs Content-Type and returns a discriminated `{kind: "json" \| "binary"}` so PNG/PDF endpoints don't get JSON-corrupted. |

### Refund-eligible failures: just log this shape

When charge-intent settles and the upstream call fails (5xx, validation error, etc.), the buyer paid for nothing. Refunds happen out-of-band by an operator script. The kit doesn't ship a wrapper — just emit one JSON line per failure with this shape, on `console.error`:

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
- [`@zeroclickai/paywrap-cli`](../cli/) (bin: `paywrap`) — interactive scaffolder (`paywrap create`), wallet generator, service publisher.
