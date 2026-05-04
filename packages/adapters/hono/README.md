# @zeroclickai/paywrap-adapter-hono

Hono adapter for [`@zeroclickai/paywrap`](../../kit/). Runs on Cloudflare Workers, Node, Bun, and anywhere else Hono runs.

## Getting started on Cloudflare Workers

End-to-end path from empty directory to a deployed, paywalled Worker. A complete working version of every step lives in [`examples/hono-worker/`](../../../examples/hono-worker/) — copy from there if you want to skip the typing.

### 1. Prerequisites

- Node 20+ and a package manager (pnpm shown below; npm/yarn/bun work).
- A Cloudflare account and `wrangler` logged in: `npx wrangler login`.
- A Tempo wallet **address** to receive funds (just the `0x…` address — no key needed for charge-intent; the buyer signs and pays gas in USDC). Provision a private key only if you plan to use session-intent or `feePayer: true` charge — see [step 5](#5-set-secrets).
- A 32-byte HMAC secret for signing MPP challenges. The HMAC is keyed off `MPP_SECRET_KEY`, not the wallet — challenge signing does not require a private key.

**Bootstrap both with the paywrap CLI** (recommended — one command, no extra tools):

```sh
npx @zeroclickai/paywrap-cli generate-secrets
# prints, in env-file format:
#   WALLET_PRIVATE_KEY=0x…   ← only needed for session-intent / feePayer:true
#   WALLET_ADDRESS=0x…       ← what you'll set in wrangler.toml for charge-intent
#   MPP_SECRET_KEY=…         ← what you'll set as a wrangler secret in step 5
```

For charge-intent only, copy `WALLET_ADDRESS` and `MPP_SECRET_KEY` and **discard the printed `WALLET_PRIVATE_KEY`** — you don't need it and shouldn't store it. For session-intent / `feePayer: true`, store the private key as a `wrangler secret` (step 5) and never commit it.

If you'd rather not use the CLI: any EOA address works for `WALLET_ADDRESS`, and `openssl rand -hex 32` produces a valid `MPP_SECRET_KEY`.

### 2. Scaffold the project

```sh
mkdir my-paywalled-worker && cd my-paywalled-worker
pnpm init
pnpm add hono @zeroclickai/paywrap @zeroclickai/paywrap-adapter-hono viem
pnpm add -D wrangler typescript @cloudflare/workers-types
```

`tsconfig.json` minimum:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### 3. `wrangler.toml`

```toml
name = "my-paywalled-worker"
main = "src/worker.ts"
compatibility_date = "2024-12-01"

# REQUIRED: mppx pulls `node:util` transitively. Without this flag the
# Worker will fail to start.
compatibility_flags = ["nodejs_compat"]

[vars]
# Public URL of this Worker. Used as the MPP realm — payers verify against
# this exact origin, so it must match what callers hit.
PUBLIC_BASE_URL = "https://my-paywalled-worker.<your-subdomain>.workers.dev"
TEMPO_RPC_URL   = "https://rpc.tempo.xyz"
# Charge-intent only needs the receive address. Swap for WALLET_PRIVATE_KEY
# (set via `wrangler secret put`) only if you add session-intent routes.
WALLET_ADDRESS  = "0xYourSellerReceiveAddress"

# Created in step 4. Replace the id after `wrangler kv namespace create`.
[[kv_namespaces]]
binding = "PAYWRAP_KV"
id = "REPLACE_WITH_REAL_NAMESPACE_ID"
```

### 4. Create the KV namespace

KV is the durable store for MPP challenge-id replay protection. Charge-intent only needs replay protection, which is safe under KV's last-write-wins semantics.

```sh
npx wrangler kv namespace create PAYWRAP_KV
```

Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 5. Set secrets

Pulled from `c.env` per request — never commit them.

```sh
npx wrangler secret put MPP_SECRET_KEY       # 32-byte hex from openssl
```

**Skip `WALLET_PRIVATE_KEY` for charge-intent.** Charge broadcasts the *buyer-signed* raw Tempo tx (`eth_sendRawTransaction`), so the seller never needs to hold a key. Your `WALLET_ADDRESS` from `wrangler.toml` is the receive address; that's it.

You only need a private key if any route on this Worker uses:

- `intent: "session"` — the server signs `openChannel` / `closeChannel` and pays gas for them in USDC.
- `feePayer: true` on a charge route — the server sponsors the buyer's gas.

If either applies, run `wrangler secret put WALLET_PRIVATE_KEY` instead of setting `WALLET_ADDRESS`, and switch to the keyed factory in step 6.

### 6. Write the Worker

`src/worker.ts`:

```ts
import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { buildOpenApiSpec } from "@zeroclickai/paywrap/manifest";
import {
  type MinimalKVNamespace,
  createPaywrapMpp,
  workersKvStore,
} from "@zeroclickai/paywrap/mpp";

export type Env = {
  PAYWRAP_KV: MinimalKVNamespace;
  WALLET_ADDRESS: string;       // receive address — charge-intent only
  MPP_SECRET_KEY: string;       // HMAC for challenge signing
  PUBLIC_BASE_URL: string;
  TEMPO_RPC_URL: string;
};

const SCOPE = "echo:1" as const;
const PRICE_MICRO = 10_000n; // 0.01 USDC (6 decimals)

// Factory ctx — Worker bindings are per-request, so we build mpp inside
// the factory rather than at module load. Address-only mode: the buyer
// signs and pays gas, so no WALLET_PRIVATE_KEY is needed. To add
// session-intent or `feePayer: true` later, swap `walletAddress` for
// `walletPrivateKey` (sourced from `wrangler secret put`).
const app = createHonoApp<{
  Bindings: Env;
  mppx: ReturnType<typeof createPaywrapMpp>["mppx"];
  mppxChannelStore: ReturnType<typeof createPaywrapMpp>["channelStore"];
}>((c) => {
  const mpp = createPaywrapMpp({
    walletAddress: c.env.WALLET_ADDRESS as `0x${string}`,
    mppSecretKey: c.env.MPP_SECRET_KEY,
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
    tempoRpcUrl: c.env.TEMPO_RPC_URL,
    store: workersKvStore(c.env.PAYWRAP_KV),
  });
  return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
});

app.get("/healthz", (c) => c.json({ status: "ok" }));

// REQUIRED for service discovery — Zero's indexer probes `/openapi.json` to
// enumerate paid routes and read pricing. Together with the live `402`
// response on each paid route, this is the entire public discovery contract.
app.get("/openapi.json", (c) => {
  return c.json(
    buildOpenApiSpec(
      {
        wallet: c.env.WALLET_ADDRESS as `0x${string}`,
        paidRoutes: [
          {
            method: "POST",
            path: "/v1/echo",
            protocol: "mpp",
            sku: "echo:1",
            priceUsdcMicro: PRICE_MICRO.toString(),
            pricingVersion: 1,
            description: "Echo the request body. Charged per request.",
            requestContentType: "application/json",
            responseContentType: "application/json",
          },
        ],
        freeRoutes: [
          { method: "GET", path: "/healthz" },
          { method: "GET", path: "/openapi.json" },
        ],
      },
      { title: "Echo Service", version: "1.0.0" },
      { serverUrl: c.env.PUBLIC_BASE_URL },
    ),
  );
});

app.post(
  "/v1/echo",
  mppGated({ scope: SCOPE, amount: PRICE_MICRO, intent: "charge" }),
  async (c) => c.json({ echoed: await c.req.json(), payer: c.var.payer }),
);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(req, env, ctx),
};
```

### 7. Run locally then deploy

```sh
npx wrangler dev      # local Worker, hits real Tempo RPC + your KV
npx wrangler deploy
```

After deploying, update `PUBLIC_BASE_URL` in `wrangler.toml` to the actual `*.workers.dev` (or custom domain) URL **and redeploy** — it's the realm callers verify against, so a mismatch breaks all paid routes.

### 8. Verify it works

```sh
# Free route — should 200.
curl https://<your-worker>/healthz

# Paid route — should 402 with an MPP challenge in WWW-Authenticate.
curl -i -X POST https://<your-worker>/v1/echo -d '{}'
```

The 402 response carries the `WWW-Authenticate: MPP ...` header. A buyer signs the challenge it describes (typically with `buildChargeCredential` from `@zeroclickai/paywrap/signing`) and retries with `Authorization: Payment <credential>`.

### What you integrated from paywrap

| Import | Purpose |
| --- | --- |
| `createPaywrapMpp` (`/mpp`) | Builds the mppx instance + channel store from your wallet/secret/RPC. |
| `workersKvStore` (`/mpp`) | Workers KV–backed replay-protection store. Required for production; in-memory dies with the isolate. |
| `createHonoApp` (adapter) | Hono app pre-wired with the `paywrapApp` ctx. Pass a factory because Worker bindings are per-request. |
| `mppGated` (adapter) | Per-route middleware that issues 402 + verifies + settles. |
| `buildOpenApiSpec` (`/manifest`) | Generates the public `/openapi.json` with `x-payment-info` + `402` responses on paid operations. This plus the live `402` headers is what Zero's indexer reads. |

Everything else in this README (per-request pricing, `preCheck` validation, x402, custom `c.var` typing) is optional polish on top of the above.

## Quickstart (Cloudflare Workers)

Two equivalent ways to wire up the paywrap app context. Use whichever matches your ctx lifetime.

### Workers-style (ctx per request)

Worker env bindings (KV, secrets) are only available per request, so the ctx can't be built at module load. Pass a factory to `createHonoApp`:

```ts
import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { createPaywrapMpp, workersKvStore } from "@zeroclickai/paywrap/mpp";

type Env = { PAYWRAP_KV: KVNamespace; WALLET_PRIVATE_KEY: string; MPP_SECRET_KEY: string };

const app = createHonoApp<{ Bindings: Env }>((c) => {
  const mpp = createPaywrapMpp({
    walletPrivateKey: c.env.WALLET_PRIVATE_KEY as `0x${string}`,
    mppSecretKey: c.env.MPP_SECRET_KEY,
    publicBaseUrl: "https://my-worker.example.com",
    tempoRpcUrl: "https://rpc.tempo.xyz",
    store: workersKvStore(c.env.PAYWRAP_KV),
  });
  return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
});

app.post("/generate", mppGated({ scope: "gen:1", amount: 50_000n, intent: "charge" }), (c) => {
  return c.json({ result: "..." });
});

export default app;
```

### Node-style (ctx known at module load)

```ts
import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";

const mpp = createPaywrapMpp({
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  mppSecretKey: process.env.MPP_SECRET_KEY!,
  publicBaseUrl: process.env.PUBLIC_BASE_URL!,
  tempoRpcUrl: "https://rpc.tempo.xyz",
});

const app = createHonoApp({ mppx: mpp.mppx, mppxChannelStore: mpp.channelStore });

app.post("/generate", mppGated({ scope: "gen:1", amount: 50_000n, intent: "charge" }), (c) =>
  c.json({ result: "..." }),
);
```

### Rolling your own middleware

If you can't use `createHonoApp`, you MUST set `paywrapApp` yourself in a pre-middleware. `mppGated` reads `c.get("paywrapApp")` — setting `c.set("mpp", mpp)` will NOT work:

```ts
app.use("*", async (c, next) => {
  const mpp = createPaywrapMpp({ ... });
  c.set("paywrapApp", {
    ctx: { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore },
  });
  await next();
});
```

## Persistent state on Workers

Workers isolates lose memory per restart. For state that must survive restarts:

- **Charge-intent**: `workersKvStore(env.PAYWRAP_KV)` — free tier (100k reads + 1k writes per day + 1GB storage). No atomicity concerns for this pattern: challenge-id replay protection is the only shared state and KV's last-write-wins semantics don't break replay protection within the mppx window.
- **Session-intent (low concurrency)**: same as above, with the caveat in [`workers-kv.ts`](../../kit/src/mpp/stores/workers-kv.ts)'s docblock — two concurrent vouchers on the same channel can corrupt `cumulativeAmount`.
- **Session-intent (concurrent)**: Durable Object–backed store — future work, not yet shipped.

`wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PAYWRAP_KV"
id = "<your-namespace-id>"
```

`compatibility_flags = ["nodejs_compat"]` at the top of `wrangler.toml` (shown in step 3) is what enables `node:util` for mppx. There is no `[build]` block needed.

## x402 protocol

Same adapter, different protocol. `x402Gated` wraps `@x402/hono`'s `paymentMiddlewareFromHTTPServer` for parity with `mppGated` — gate one route at a time without standing up a top-level x402 router. Settlement runs through a facilitator on Base (mainnet) or Base Sepolia (testnet); the seller wallet is just the receive address.

```ts
import { Hono } from "hono";
import { createPaywrapX402 } from "@zeroclickai/paywrap/x402";
import { x402Gated } from "@zeroclickai/paywrap-adapter-hono";

const x402 = createPaywrapX402({
  payTo: "0xYourSellerAddress",
  network: "base", // or "base-sepolia" for testnet
  // facilitator: { url: "https://x402.org/facilitator" } — default
});

const app = new Hono();
app.post("/generate", x402Gated(x402, { price: "0.005" }), (c) =>
  c.json({ result: "..." }),
);
```

You can mix protocols on the same Hono app — register `mppGated` on routes that should accept MPP credentials and `x402Gated` on routes that should accept x402 payments. OpenAPI's `x-payment-info` already carries per-route `protocol: "mpp" | "x402"`, so indexers can route accordingly.

For routes that need a custom `accepts` (multiple schemes/networks, non-USDC asset), pass `acceptsOverride` instead of `price`.

## Non-Workers runtimes

The adapter is runtime-agnostic. On Node or Bun, use `redisStore(new IORedis(...))` from `@zeroclickai/paywrap/mpp` for durable, linearizable state. `workersKvStore` is Workers-specific.

## Typing custom data on `c.var`

`mppGated` already sets typed `c.var.payer` and `c.var.verifiedCredential`. If your `preCheck` needs to stash data for the handler — e.g. a parsed body or a derived id — use module augmentation so the keys are typed end-to-end:

```ts
declare module "@zeroclickai/paywrap-adapter-hono" {
  interface PaywrapBindings {
    sandboxInput?: { sandboxName: string; chargeHash: string };
  }
}

// preCheck:
c.set("sandboxInput", { sandboxName: "foo", chargeHash: "ff00" });

// handler — fully typed:
const input = c.get("sandboxInput");
if (input) console.log(input.chargeHash);
```

The `as never` cast pattern works for one-off prototypes (`c.set("foo" as never, value as never)`) but module augmentation is preferred for anything that ships.

## Avoiding double-parsing in `preCheck`

Hono's `c.req.json()` memoizes per request — calling it again from the handler returns the cached parse. Same for `c.req.formData()` etc. So a `preCheck` that needs to read the body can safely call `c.req.json()` without forcing the handler to re-parse.

## Validate before charging

For charge-intent routes, `mppGated` settles before your handler runs. Put cheap local validation in `preCheck` so callers are not charged for malformed JSON, unsupported options, name collisions, quota failures, or idempotent retries.

```ts
app.post(
  "/v1/render",
  mppGated({
    scope: "render:v1",
    intent: "charge",
    amount: 1000n,
    preCheck: async ({ c }) => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.diagram !== "string") {
        return { ok: false, status: 400, body: { error: "invalid_body" } };
      }
      c.set("renderBody" as never, body as never);
      return { ok: true };
    },
  }),
  async (c) => {
    const body = c.get("renderBody" as never) as { diagram: string };
    return c.json({ diagram: body.diagram, payer: c.var.payer });
  },
);
```

`claimedPayer` in `preCheck` is only a pre-verify hint. Use it to choose what to read, not to commit irreversible writes.

## `mppGated` options

`mppGated(options)` returns a Hono middleware that handles the full 402 → verify → settle dance for one route. It reads the `paywrapApp` ctx (`mppx`, `mppxChannelStore`) set by `createHonoApp`.

```ts
mppGated({
  scope,        // string — HMAC-bound to the challenge id; must match across challenge + verify
  intent?,      // "session" | "charge" | "proof"; defaults to "proof" when amount is omitted,
                //   "session" when amount > 0. There is NO implicit charge default — pass it
                //   explicitly for atomic single-shot pricing.
  amount?,      // bigint micro-USDC. Required for "charge" and "session". Omit for "proof".
  meta?,        // Record<string, string> echoed into the 402 challenge body and
                //   surfaced in `payment_required` / `payment_settled` log events. Standard
                //   keys: `sku`, `pricingVersion`.
  preCheck?,    // async ({ c, claimedPayer }) => PreCheckResult — see below.
})
```

`preCheck` runs after the credential is parsed but before verify/settle. Use it for cheap local validation that should not consume a charge.

```ts
type PreCheckResult =
  | { ok: true }
  | { ok: false; status: number; body: unknown }
  | { ok: "already_done"; payer: `0x${string}`; verifiedCredential: VerifiedCredential };
```

- `{ ok: true }` — proceed to verify + settle.
- `{ ok: false, status, body }` — short-circuit with that status/body without charging. Use for malformed input, name collisions, quota failures.
- `{ ok: "already_done", payer, verifiedCredential }` — skip verify entirely; the route already handled this credential idempotently. The handler still gets typed `c.var.payer` and `c.var.verifiedCredential`.

`claimedPayer` is the address parsed from the credential before verification. It is only a hint — safe for reads and routing decisions, never for irreversible writes. The adapter emits `payment_failed` with `stage: "precheck"` if `preCheck` throws.

## Per-request pricing

If price comes from Worker env or a route registry, build the gate in a tiny route middleware so the challenge amount matches runtime config and `/openapi.json`.

```ts
app.post(
  "/v1/render",
  async (c, next) => {
    const gate = mppGated({
      scope: "render:v1",
      intent: "charge",
      amount: BigInt(c.env.SKU_PRICE_USDC_MICRO),
      meta: { sku: "render:v1", pricingVersion: "1" },
    });
    return gate(c as never, next);
  },
  async (c) => c.json({ ok: true }),
);
```
