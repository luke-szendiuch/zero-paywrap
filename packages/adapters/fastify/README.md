# @zerorun/paywrap-adapter-fastify

Fastify adapter for [`@zerorun/paywrap`](https://github.com/zeroclickai/zero-paywrap). Collapses the 10-line MPP auth dance into a single `mppGated` preHandler.

## Install

```bash
pnpm add @zerorun/paywrap @zerorun/paywrap-adapter-fastify
```

`fastify@^5` is a peer dependency.

## Use

```ts
import Fastify from "fastify";
import { createPaywrapMpp } from "@zerorun/paywrap/mpp";
import { createFastifyApp } from "@zerorun/paywrap-adapter-fastify";

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
- `extractCredential(headerValue)` — re-exported from `@zerorun/paywrap/auth`.

## Design

Kit returns `{status, headers, body}` descriptors. This adapter maps those onto Fastify's `reply.status().header().send()`. Same pattern is used by `@zerorun/paywrap-adapter-hono` — see the repo for a Hono-shaped version.

## License

MIT.
