# Next steps + open plan

Living doc. Last updated: 2026-05-04. Update when work lands.

## Current state

### Production services (both LIVE)
- **Redis integration** (session intent) — https://zero-redis-integration.onrender.com — paid runs proven via `zero fetch` against the redis sibling repo.
- **Netlify integration** (charge intent) — https://zero-integrations.onrender.com — paid deploy proven E2E 2026-04-24: $0.02 settled on Tempo → zip uploaded → site served at https://zerotest7.netlify.app/. Seller wallet `0x253671ba1267Bc9F21F3E51A0e6D07928753470B` (no funding needed; charge-intent buyer pays gas).

### What's on npm
| Package | Version | Notes |
|---|---|---|
| [`@zeroclickai/paywrap`](https://www.npmjs.com/package/@zeroclickai/paywrap) | 0.0.1 | Kit |
| [`@zeroclickai/paywrap-adapter-fastify`](https://www.npmjs.com/package/@zeroclickai/paywrap-adapter-fastify) | 0.0.1 | |
| [`@zeroclickai/paywrap-adapter-hono`](https://www.npmjs.com/package/@zeroclickai/paywrap-adapter-hono) | 0.0.1 | Workers-safe |
| [`@zeroclickai/paywrap-cli`](https://www.npmjs.com/package/@zeroclickai/paywrap-cli) | 0.0.1 | bin: `paywrap` |
| [`@zeroxyz/cli`](https://www.npmjs.com/package/@zeroxyz/cli) | 0.0.30 | Buyer CLI. **Note:** binary upload via `-d @<file>` requires the v0.0.31+ release (PR piedotorg/zero#140 merged 2026-04-24, not yet tagged on npm at time of writing). |

### Repos
| Repo | Status |
|---|---|
| `zeroclickai/zero-paywrap` (private) | Kit + adapters + CLI. 143 tests green. v0.0.1 published. |
| `zeroclickai/zero-redis-integration` (private) | Session-intent service. 66/66 tests. Live on Render. |
| `zeroclickai/zero-integrations` (private monorepo) | Hosts `services/netlify/`. 72/72 tests. Live on Render — main is current. |
| `piedotorg/zero` (the main Zero repo) | Buyer CLI + API. PR #140 merged: `zero fetch -d @<file>` now sends raw bytes (was UTF-8-decoded; broke binary uploads). |

### What was proven E2E on 2026-04-24
- `zero fetch -d @site.zip -H "Content-Type: application/zip" <url>` end-to-end against the live netlify service.
- Six bugs discovered + fixed during dogfooding:
  1. Render Docker context scoped too narrowly (zero-integrations#1).
  2. Pricing dropped $0.05 → $0.02 per deploy (zero-integrations#2).
  3. Service accepts three content-types: raw `application/zip`, JSON `{zipBase64,...}`, multipart (zero-integrations#3).
  4. Netlify zip-deploy POST must NOT send `Accept: application/json` — flips the API into manifest-mode and dedupes against an empty baseline (zero-integrations#5).
  5. Fastify's pooled Buffer reused after `setImmediate`; defensive copy via `Buffer.allocUnsafeSlow` (zero-integrations#6).
  6. Zero CLI's `-d @<path>` was UTF-8-decoding files and corrupting binary; default Content-Type also flipped from `application/json` to `application/octet-stream` for `@<path>` (zero/#140).

---

## Immediate next steps (ranked by leverage)

### 1. Tag + publish `@zeroxyz/cli` v0.0.31 (5 min)
PR piedotorg/zero#140 is merged. Cut `v0.0.31` tag → release-cli workflow → npm publish. Until that ships, `npm i -g @zeroxyz/cli@latest` still has the binary-upload bug (366-byte zip arrives as 590 bytes of replacement chars on the wire).

### 2. Document the programmatic-buying pattern (30 min)
Add a section to `packages/kit/README.md` titled "Buying paywrap services programmatically" with two snippets:
- **Charge intent (~15 LOC)**: `fetch → if 402 → buildChargeCredential → retry`. Copy-pasteable.
- **Session intent (~40 LOC)**: opens a channel, tracks cumulative amount, signs voucher per request. Points at `buildVoucherCredential` + explains the channel lifecycle.

This covers the use case a separate SDK would address, without the package overhead. If demand for an SDK materializes later, we already have validated building blocks.

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

### `@zeroclickai/paywrap-client` — deferred, demand-driven
Originally scoped as priority #2. Demoted after honest review: the Zero CLI handles 95%+ of MPP buying today. A separate SDK package targets **programmatic agents writing code** (LangChain tools, Cloudflare AI agents, OpenAI Agents SDK integrations) who need `createPayingFetch` inside their tool-use loop rather than shelling out to `zero fetch`. That's a theoretical use case at our current scale.

**Ship it when:** someone building an agent framework plugin specifically asks. Zero CLI stays separate (per 2026-04-23 decision), so no buyer-side primitives will surface from a CLI refactor. Until external demand appears, the kit primitives + documented pattern are sufficient.

**What it would contain** (reference, in case we build it later):
- `createPayingFetch({ account, maxPay, chainBridge? })` — wraps `fetch`, handles 402 detection + retry
- `discoverPaywrap(url)` — fetch + zod-validate `.well-known/paywrap.json`
- `parseChallengeFromResponse(response)` — parse www-authenticate
- `openChannel({ ... })` — on-chain deposit for session intent
- `createBuyerSession({ payer, channelId })` — stateful voucher incrementer
- `bridgeToTempo({ fromChain, amount, payer })` — Relay SDK wrapper
- `checkUsdcBalance({ payer, chain })` — balance probe

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
2. `git log --oneline -20` in `/Users/bruceirons/agent-repos/zero-paywrap/`.
3. `git log --oneline -10` in `zero-integrations/` and `zero-redis-integration/`.
4. Health checks (both should 200):
   - `curl https://zero-redis-integration.onrender.com/healthz` → `{ok:true, probes:{db:"up", redis:"up"}, wallet:"0xb9Ce..."}`
   - `curl https://zero-integrations.onrender.com/healthz` → `{ok:true, probes:{netlify:"up"}, wallet:"0x2536..."}`
5. `npm view @zeroclickai/paywrap version` and `npm view @zeroxyz/cli version`.
6. Pick from "Immediate next steps" and proceed.
