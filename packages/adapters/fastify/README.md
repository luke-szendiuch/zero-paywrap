# @zeroclickai/paywrap-adapter-fastify

Fastify adapter for [`@zeroclickai/paywrap`](https://github.com/zeroclickai/zero-paywrap). Collapses the 10-line MPP auth dance into a single `mppGated` preHandler.

## Install

```bash
pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-fastify
```

`fastify@^5` is a peer dependency.

## Use

```ts
import Fastify from "fastify";
import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";
import { createFastifyApp } from "@zeroclickai/paywrap-adapter-fastify";

const mpp = createPaywrapMpp({
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  mppSecretKey: process.env.MPP_SECRET_KEY!,
  publicBaseUrl: process.env.PUBLIC_BASE_URL!,
  tempoRpcUrl: "https://rpc.tempo.xyz",
});

const app = await createFastifyApp({
  mppx: mpp.mppx,
  mppxChannelStore: mpp.channelStore,
  walletAddress: mpp.account.address,
});

app.post("/generate", {
  preHandler: app.mppGated({ scope: "gen:1", amount: 50_000n, intent: "charge" }),
}, async (req) => {
  const payer = req.payer;                // Hex, verified
  const verified = req.verifiedCredential; // VerifiedCredential (branded)
  return { result: await yourLogic(req.body, payer) };
});

await app.listen({ port: 3000 });
```

## API

- `createFastifyApp(ctx)` — preconfigured Fastify instance with Zod type provider, ctx decoration, `mppGated` decorator.
- `mppGated({ scope, amount?, intent?, meta?, preCheck? })` — preHandler factory; consults `app.ctx.mppx`. Options:
  - `intent`: `"session" | "charge" | "proof"`. Default: `"proof"` when `amount` omitted, `"session"` when `amount` > 0.
  - `preCheck(ctx)` — async hook that runs AFTER credential parse but BEFORE verify/settle. Return `{ok: true}` to proceed, `{ok: false, status, body}` to short-circuit without charging, or `{ok: "already_done", payer, verifiedCredential}` to skip verify on idempotent retries.
- `sendSessionChallenge(app, reply, opts)` / `sendChargeChallenge(app, reply, opts)` / `sendProofChallenge(app, reply, scope, detail, meta?)` — manual 402 responders.
- `extractCredential(headerValue)` — re-exported from `@zeroclickai/paywrap/auth`.
- `defensiveBufferCopy(source)` — Node-only helper that copies a Fastify-managed Buffer into a fresh, pool-free allocation. **Use this whenever you fire-and-forget after the reply** (see Gotchas).

## Gotchas

### Pooled Buffers + `setImmediate` after reply

Fastify's content-type parsers (`@fastify/multipart`, `addContentTypeParser({parseAs: "buffer"})`) return Buffers backed by a shared pool. A 200-byte upload typically lives at byteOffset=520 of an 8192-byte pool. If your route does:

```ts
reply.status(202).send({ ok: true });
// ❌ DANGER: zipBytes is a pool view; the next request can recycle the slot
setImmediate(() => upstream.upload(req.body));
```

Fastify can release the request and recycle that pool slot before `setImmediate` fires. The fire-and-forget then ships **the wrong bytes** — observed live in the netlify integration: Netlify reported a "ready" deploy with an empty file_tree because the bytes it received didn't match the buyer's zip.

Fix:

```ts
import { defensiveBufferCopy } from "@zeroclickai/paywrap-adapter-fastify";

reply.status(202).send({ ok: true });
const safeCopy = defensiveBufferCopy(req.body as Buffer);
setImmediate(() => upstream.upload(safeCopy));   // ✅ pool-free
```

`Buffer.from(buf)` and `Uint8Array.from(buf)` both round-trip through the pool for small allocations and don't fix this. `defensiveBufferCopy` uses `Buffer.allocUnsafeSlow` which bypasses the pool.

## Design

Kit returns `{status, headers, body}` descriptors. This adapter maps those onto Fastify's `reply.status().header().send()`. Same pattern is used by `@zeroclickai/paywrap-adapter-hono` — see the repo for a Hono-shaped version.

## License

MIT.
