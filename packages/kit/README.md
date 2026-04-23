# @zerorun/paywrap

Framework-agnostic primitives for building **paid API services** that speak payment protocols over HTTP. Today the kit covers **MPP** (session + charge intents on Tempo, USDC settlement); **x402** is the next protocol we're slotting in alongside without breaking consumers.

The kit is intentionally narrow — everything here is runnable from any Node HTTP framework. For Fastify, layer [`@zerorun/paywrap-adapter-fastify`](../adapters/fastify/) on top. For a turnkey project scaffold (routes, env schema, Render config), use the [`paywrap`](../cli/) CLI.

## Subpaths

The kit ships **no root barrel** — import only the subpath you need. This keeps your bundle tight and the dependency graph honest.

| Subpath | Exports | Reach for it when… |
|---|---|---|
| `@zerorun/paywrap/mpp` | `createPaywrapMpp`, `memoryStore`, `redisStore`, `closeSessionOnChain`, `verifyWithScope`, `assertVoucherAdvances`, `TEMPO_ESCROW`, `TEMPO_USDC`, `TEMPO_CHAIN_ID`, `tempoChain` | Bootstrapping mppx, choosing a channel-state store, verifying credentials at route handlers, closing channels on-chain. |
| `@zerorun/paywrap/auth` | `buildSessionChallenge`, `buildChargeChallenge`, `buildProofChallenge`, `payerFromCredential`, `VerifiedCredential`, `VERIFIED` (brand symbol) | Minting 402 challenges from any framework, resolving the authenticated payer address from a verified credential. |
| `@zerorun/paywrap/signing` | `signVoucher`, `buildVoucherCredential`, `channelIdFromLabel` | Buyer-side code (CLI, agent) producing signed Tempo vouchers. Useful in integration tests too. |
| `@zerorun/paywrap/testing` | `seedChannel` | Seeding a `ChannelStore` with a fake-open channel in tests. Not for production. |
| `@zerorun/paywrap/crypto` | `encryptSecret`, `decryptSecret`, AES-256-GCM helpers | At-rest encryption of upstream credentials (connection strings, API tokens) stored in your DB. |
| `@zerorun/paywrap/manifest` | `buildPaywrapJson` | Serving `/.well-known/paywrap.json` — the service manifest indexers + agents use to learn your pricing. |
| `@zerorun/paywrap/health` | `aggregateHealthProbes` | Assembling `/healthz` responses from per-subsystem probes. |
| `@zerorun/paywrap/setup` | `generateWallet`, `generateMppSecretKey`, `prefundWallet`, `registerWithZero` | One-shot setup scripts the CLI wraps; callable from a consumer's own `pnpm setup`. |

## End-to-end example: a 402 paid call

A buyer calls your paid endpoint with no credential; the server replies 402 with a `www-authenticate: Payment <...>` challenge; the buyer opens a channel + signs a voucher, then retries.

```sh
# 1. Buyer hits the endpoint with no payment header.
curl -X POST "https://api.example.com/v1/things" -i

# HTTP/1.1 402 Payment Required
# www-authenticate: Payment eyJyZWFsbSI6ImFwaS5leGFtcGxlLmNvbSIsIm1ldGhvZCI6InRlbXBvIiwiaW50ZW50Ijoic2Vzc2lvbiIsIi4uLiI6Ii4uLiJ9...
# content-type: application/json
# {"challenge":{...},"detail":"payment_required"}

# 2. Buyer mints a credential from the challenge (CLI does this transparently),
#    opens a Tempo channel, signs a voucher, and retries with the credential
#    in the Authorization header:
curl -X POST "https://api.example.com/v1/things" \
  -H "Authorization: Payment eyJjaGFsbGVuZ2UiOnsiLi4uIjoiLi4uIn0sInBheWxvYWQiOnsiY2hhbm5lbElkIjoiMHguLi4iLCJjdW11bGF0aXZlQW1vdW50IjoiMjAwMDAiLCJzaWduYXR1cmUiOiIweC4uLiJ9fQ=="

# HTTP/1.1 202 Accepted
# {"id":"thing_...","state":"provisioning"}
```

On the server side the route handler goes through the standard three-step pattern:

```ts
import { extractCredential, sendSessionChallenge } from "@zerorun/paywrap-adapter-fastify";
import { payerFromCredential } from "@zerorun/paywrap/auth";
import { verifyWithScope } from "@zerorun/paywrap/mpp";

app.post("/v1/things", async (req, reply) => {
	const header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
	const credential = extractCredential(header);
	if (!credential) {
		return sendSessionChallenge(app, reply, {
			amount: "0.02", suggestedDeposit: "0.02", unitType: "request",
			scope: "my-svc:1", detail: "payment_required",
		});
	}

	// verifyWithScope is the ONLY way to produce a VerifiedCredential. Downstream
	// helpers (payerFromCredential, etc.) accept only the branded shape — forget
	// the scope check and TypeScript rejects the callsite.
	const verified = await verifyWithScope(app.ctx.mppx, credential, "my-svc:1");

	const payer = await payerFromCredential(app.ctx.channelStore, verified);
	if (!payer) return reply.status(500).send({ error: "channel_state_missing" });

	// ... create your resource, return 202 ...
});
```

## Security contract

`verifyWithScope` is the **only** factory that produces a `VerifiedCredential`. The branded type uses a module-private symbol, so no caller can forge the verified shape to hand to `payerFromCredential` without actually running the scope check. This closes a class of footguns where a route forgets to check the credential's scope and accepts a cross-route replay.

HMAC-bound challenge ids + scope enforcement are load-bearing: the kit enforces them at the type level.

## Related packages

- [`@zerorun/paywrap-adapter-fastify`](../adapters/fastify/) — Fastify adapter: `sendSessionChallenge`, `sendChargeChallenge`, `sendProofChallenge`, `extractCredential`, `createFastifyApp`.
- [`@zerorun/paywrap-cli`](../cli/) (bin: `paywrap`) — interactive scaffolder (`paywrap create`), wallet generator, service publisher.
