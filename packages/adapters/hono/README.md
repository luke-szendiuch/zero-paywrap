# @zeroclickai/paywrap-adapter-hono

Hono adapter for [`@zeroclickai/paywrap`](../../kit/). Runs on Cloudflare Workers, Node, Bun, and anywhere else Hono runs.

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

[build]
nodejs_compat = true  # required for node:util (transitive via mppx)
```

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

You can mix protocols on the same Hono app — register `mppGated` on routes that should accept MPP credentials and `x402Gated` on routes that should accept x402 payments. Indexers reading `/.well-known/paywrap.json` already see per-route `protocol: "mpp" | "x402"`.

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

## Per-request pricing

If price comes from Worker env or a route registry, build the gate in a tiny route middleware so the challenge amount matches runtime config and `/.well-known/paywrap.json`.

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
