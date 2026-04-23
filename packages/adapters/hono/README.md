# @zerorun/paywrap-adapter-hono

Hono adapter for [`@zerorun/paywrap`](../../kit/). Runs on Cloudflare Workers, Node, Bun, and anywhere else Hono runs.

## Quickstart (Cloudflare Workers)

```ts
import { Hono } from "hono";
import { createPaywrapMpp } from "@zerorun/paywrap/mpp";
import { workersKvStore } from "@zerorun/paywrap/mpp";
import { mppGated, createChallengeHelpers } from "@zerorun/paywrap-adapter-hono";

type Env = { PAYWRAP_KV: KVNamespace; WALLET_PRIVATE_KEY: string; MPP_SECRET_KEY: string };

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const mpp = createPaywrapMpp({
    walletPrivateKey: c.env.WALLET_PRIVATE_KEY as `0x${string}`,
    mppSecretKey: c.env.MPP_SECRET_KEY,
    publicBaseUrl: "https://my-worker.example.com",
    tempoRpcUrl: "https://rpc.tempo.xyz",
    store: workersKvStore(c.env.PAYWRAP_KV),
  });
  c.set("mpp", mpp);
  await next();
});

app.post("/generate", mppGated({ scope: "gen:1", amount: 50_000n, intent: "charge" }), async (c) => {
  return c.json({ result: "..." });
});

export default app;
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

## Non-Workers runtimes

The adapter is runtime-agnostic. On Node or Bun, use `redisStore(new IORedis(...))` from `@zerorun/paywrap/mpp` for durable, linearizable state. `workersKvStore` is Workers-specific.
