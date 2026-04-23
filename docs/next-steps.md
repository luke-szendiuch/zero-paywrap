# Next steps + open plan

Living doc. Last updated: 2026-04-23. Update when work lands.

## Current state

### What's on npm (v0.0.1)
- [`@zeroclickai/paywrap`](https://www.npmjs.com/package/@zeroclickai/paywrap) — kit
- [`@zeroclickai/paywrap-adapter-fastify`](https://www.npmjs.com/package/@zeroclickai/paywrap-adapter-fastify)
- [`@zeroclickai/paywrap-adapter-hono`](https://www.npmjs.com/package/@zeroclickai/paywrap-adapter-hono)
- [`@zeroclickai/paywrap-cli`](https://www.npmjs.com/package/@zeroclickai/paywrap-cli) (bin: `paywrap`)

### Repos
| Repo | Where | Status |
|---|---|---|
| `zero-paywrap` | [github.com/zeroclickai/zero-paywrap](https://github.com/zeroclickai/zero-paywrap) (private) | `main` = `7a0e4ef`. Build + lint + 143 tests green. |
| `zero-redis-integration` | [github.com/zeroclickai/zero-redis-integration](https://github.com/zeroclickai/zero-redis-integration) (private) | `main` merged + **deployed to Render on `@zeroclickai/paywrap@0.0.1`**. 66/66 tests green. |
| `zero-netlify-integration` | local only, not pushed | `main` at `76a01ea80`. 70/70 tests green locally. Still using `file:../` deps; needs the npm-scope swap before push. |
| `zero` (main Zero repo) | [github.com/zeroclickai/zero](https://github.com/zeroclickai/zero) | Untouched during paywrap work. Buyer-side `PaymentService` still hand-rolled. |

### Production services
- **Redis integration** (session intent): `https://zero-redis-integration.onrender.com` — live, healthz + paywrap.json verified against new kit
- **Netlify integration** (charge intent): not deployed yet

---

## Immediate next steps (ranked by leverage)

### 1. Push + deploy zero-netlify-integration
- Swap `file:../zero-paywrap/...` deps in `package.json` → `"@zeroclickai/paywrap": "^0.0.1"` + `"@zeroclickai/paywrap-adapter-fastify": "^0.0.1"`
- Sweep imports `@zerorun/paywrap*` → `@zeroclickai/paywrap*` (same sed sweep we did for redis)
- `pnpm install` → regenerate lockfile
- `pnpm test` → all 70 should still pass
- Create GitHub repo under `zeroclickai`, push as PR branch (never push main directly — repo memory rule)
- Set up Render (or Fly or Cloudflare Workers) deploy: needs `NETLIFY_API_TOKEN`, `MPP_SECRET_KEY`, `WALLET_PRIVATE_KEY`, `TEMPO_RPC_URL`, `REDIS_URL`
- Fund the service wallet with ~$0.10 USDC on Tempo for charge fee-gas (the charge settlement tx is paid by the seller)
- `paywrap register` to publish to Zero's catalog

Effort: ~1 hour to push + 30 min to wire Render env.

### 2. Buyer SDK: `@zeroclickai/paywrap-client`
Ship `createPayingFetch({ account, maxPay, chainBridge? })` which returns a `typeof fetch` that transparently handles 402s for MPP (and later x402). Target behavior:

```ts
const payingFetch = createPayingFetch({ account, maxPay: 0.50 });
const res = await payingFetch("https://api.example.com/generate", { method: "POST", body });
// Handled internally: 402 detection → channel open if needed → sign voucher → retry → Response
```

**Why this matters:** every buyer today reimplements ~150 LOC of MPP plumbing (see `zero/packages/cli/src/services/payment-service.ts`). Without a buyer SDK, sellers don't get customers. Currently the highest-leverage open item.

**Building blocks inside the SDK:**
- `discoverPaywrap(url)` — fetch + zod-validate `.well-known/paywrap.json`
- `parseChallengeFromResponse(response)` — detect 402, parse www-authenticate
- `openChannel({ payer, escrow, deposit, chainId, rpcUrl })` — on-chain deposit for session
- `createBuyerSession({ payer, channelId })` — stateful voucher incrementer
- `bridgeToTempo({ fromChain, amount, payer })` — Relay SDK wrapper
- `checkUsdcBalance({ payer, chain })` — balance probe

Effort: ~1-2 days to ship a credible v0.0.1. Dogfood target: refactor `zero` CLI's `payment-service.ts` onto it — ~150 LOC deletion in Zero. That's the acceptance test.

### 3. Dogfood round 2 against published packages
The round-1 dogfood (fresh agent, `examples/hono-worker/`) ran against `file:../` deps. A real external dev starts from `pnpm add @zeroclickai/paywrap @zeroclickai/paywrap-adapter-hono`. Spin up a fresh agent (no context) with ONLY:
- the published packages on npm
- the GitHub READMEs

Target task: same joke endpoint as round 1, but against npm. Should finish in <60 min per the Phase 6 prediction. Failure modes worth watching:
- Does `pnpm add` on a private GitHub org repo actually work, or does the reader need extra npm config?
- Does the Hono README still have any `c.set("mpp")` residue (Phase 6 fixed it, verify)?
- Does `buildChargeCredential` + `stubVerifyCredential` land well from the test perspective?

Effort: 30-90 min. Produces a much more honest DX signal than round 1.

### 4. Cloudflare Workers E2E deploy of the hono-worker example
The Worker code compiles and tests green, but it hasn't hit a real `wrangler deploy`. A real deploy would expose:
- `nodejs_compat = true` requirement (`node:util` from mppx) — documented but not field-tested
- KV namespace binding correctness
- Workers secret setup (`WALLET_PRIVATE_KEY`, `MPP_SECRET_KEY`)
- Whether a funded Tempo wallet actually lets charge settle on-chain from a Worker

Effort: 30 min of wrangler config + 5 min of paid test request. Requires a CF account.

### 5. Merge `paywrap` + `paywrap-cli` into one package? (DEFERRED — user already confirmed separate is right)
User asked; we agreed separate packages is correct. CLI is invoked via `npx`, runtime services don't carry scaffolder deps. **No action needed.** Documented in root README + kit README.

---

## Deferred / thinking about

### Durable Objects store for linearizable Workers session-intent
Workers KV is not atomic (ship-documented). Session-voucher accounting at concurrency needs linearizable storage. Durable Objects solve it, but Workers free tier doesn't include DO. Postpone until there's a real Workers session-intent consumer asking for it.

### Express adapter
Mechanical mirror of Fastify adapter — ~100 LOC. Ship on demand. Most new Node APIs are Fastify or Hono; Express matters for legacy codebases.

### `paywrap init` / `paywrap add-gated-route` CLI
For adding MPP to an existing project without scaffolding a new one. Drops an `.env.example` template + a sample middleware file. Nice-to-have. Not needed since the kit's Path A already works with a one-paragraph doc.

### Stripe-style test-mode facilitator
Deterministic signer + in-memory chain so downstream services can integration-test charge-intent paid paths without real Tempo RPC. We ship `stubVerifyCredential` today; a full facilitator would let you exercise actual on-chain settlement mock. Probably worth doing once we have 3+ consumers.

### x402 support
When the x402 spec stabilizes + we have concrete use case, land primitives in `packages/kit/src/x402/` parallel to MPP. Tree-shake friendly — existing consumers don't pay the cost unless they opt in.

### Server-side manifest filter at Netlify
Netlify reaper currently pages `GET /sites` + filters by `metadata.expires_at < now` client-side. If Netlify exposes server-side metadata filtering on the sites endpoint, the reaper scales linearly with expired-site count instead of total-site count. Not a v1 blocker.

### Buyer bandwidth quota on Netlify service
One viral buyer can exhaust the shared monthly Netlify bandwidth allocation of the entire service team. Product decision: do we pass the cost through per-deploy (charge more for bandwidth-heavy content), cap per-deploy, or move to paid Netlify Pro? Flag for when traffic arrives.

---

## Known gotchas (don't relearn these)

1. **npm's 2FA for publish is mandatory (2023+).** Account-level 2FA isn't enough — publishes need either an OTP per request OR a granular access token with "Bypass 2FA for publishing" explicitly checked. User has a 7-day-expiry token right now; renew as needed.

2. **Don't commit `.npmrc` with tokens.** The paywrap repo's `.gitignore` includes `.npmrc`. Check tokens aren't leaking if you edit the file.

3. **~/.npmrc tokens confuse `pnpm install` of public packages.** If the user's `~/.npmrc` has an npm.org token with write-only scope, pnpm sends it on read requests and gets 404 instead of graceful fallback. Workaround: local `.npmrc` with blank `_authToken` in the consumer repo. Better: remove the write-only token from `~/.npmrc` after publishing.

4. **Render deploys from `main` only** on the redis service. Feature branches don't trigger builds. This is why we always use PR → merge rather than push main directly (matches user memory rule anyway).

5. **`feeToken: USDC` is tempo-chain-specific.** viem's base `Chain` type doesn't know about it. The kit exposes `tempoChain: any` with the feeToken wired in. Any new chain added later needs its own `feeToken` audit.

6. **mppx `node:util` import blocks pure-Workers runtime.** `nodejs_compat = true` in `wrangler.toml` polyfills it. If this becomes a problem, file an upstream issue with mppx to shim their `node:util` usage.

7. **Workers KV is NOT linearizable.** Our store adapter implements mppx's `AtomicStore` interface mechanically but can lose updates on concurrent writes. Safe for charge-intent and low-concurrency session; unsafe for high-concurrency session.

8. **mppx's `tempo.charge.verify()` is atomic on-chain.** Unlike session's verify-then-defer-settle pattern, charge settles during verify. Order of operations in routes: validate zip/input → check idempotency (pre-verify, external state) → verify (money moves) → complete external side-effect. Reversing those risks paying without delivering.

9. **`VerifiedCredential` is branded.** The only way to construct one is through `verifyWithScope`. Callers CAN'T pass raw credentials to `payerFromCredential` anymore (compile error). If you see tests passing `as unknown as VerifiedCredential`, that's a code smell — use `stubVerifyCredential` instead.

10. **The kit's root export (`@zeroclickai/paywrap` with no subpath) was deleted per CLAUDE.md "no barrels."** All imports must go through subpaths: `/mpp`, `/auth`, `/signing`, `/crypto`, `/manifest`, `/health`, `/setup`, `/testing`.

11. **CLI-scaffolded charge-intent services are stateless by design.** They don't generate drizzle / DB / PGlite test harness. If you clone the Netlify service expecting a DB, you'll be surprised — its source of truth is the upstream provider's API + metadata.

---

## Open questions for user (low priority unless flagged)

- When do we want to publish v0.1.0? (Next significant feature: buyer SDK probably bumps us there.)
- When do we make the paywrap GitHub repo public? Currently private. Nothing secret in it.
- Do we need a license other than MIT? Shipped as MIT; change before v0.1.0 if we want something different.
- `paywrap` domain on npm — does `@zeroclickai/paywrap` work as a long-term brand, or should the public package be unscoped (`paywrap`)? Unscoped names are available on npm if `paywrap` is free. Affects long-term docs/SEO.

---

## How to resume after compact

1. Read this file.
2. `git log --oneline -20` in `/Users/bruceirons/agent-repos/zero-paywrap/` to see where we left off.
3. `git log --oneline -10` in redis + netlify consumers for their state.
4. `curl https://zero-redis-integration.onrender.com/healthz` — if this returns `{ok:true, probes:{db:"up", redis:"up"}, wallet:"0xb9Ce..."}`, production is healthy on the kit.
5. `npm view @zeroclickai/paywrap version` — confirms current published version.
6. Pick an item from "Immediate next steps" and proceed.
