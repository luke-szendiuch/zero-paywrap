# paywrap — product + architecture overview

**Status:** v0.0.1-local — working across three repos, not yet published to npm.
**Audience:** us, to sync on what this is, what it's not, and where it's going.

---

## One-line pitch

Paywrap is the toolkit for putting a crypto-gated 402 in front of any API. Sellers add a preHandler + get paid in USDC on Tempo; buyers sign a voucher and fetch normally.

## The problem it solves

We want AI agents to pay other AI services programmatically, without OAuth, API keys, or human-in-the-loop signups. MPP (Machine Payments Protocol) on Tempo solves the payment layer; paywrap solves the **integration layer** around it:

- **For sellers**: the primitives to accept MPP payments on an existing API *or* scaffold a new service from scratch
- **For buyers**: primitives to consume paid APIs without re-implementing the 150-line payment dance every time *(buyer SDK is on the roadmap; not shipped yet)*

Without paywrap, every seller building an MPP service would re-solve: challenge HMAC binding, voucher replay protection, AEAD for stored secrets, `feeToken: USDC` on the chain config, session-close-on-chain idempotency, scope-bound verification. We've seen this go wrong enough times (two regression bugs already) to know the kit is load-bearing.

## Two first-class use cases

Paywrap supports both modes equally. Neither is "the real way."

### Path A — Drop-in: add MPP to an existing API

You have a Fastify/Hono/Express API. You want to charge for one or more endpoints. Install two packages, write ~10 lines of middleware:

```ts
import { createPaywrapMpp } from '@zeroclickai/paywrap/mpp';
import { mppGated, createFastifyApp } from '@zeroclickai/paywrap-adapter-fastify';

const mpp = createPaywrapMpp({ /* wallet, secret, baseUrl, rpc */ });
const app = await createFastifyApp({ mppx: mpp, /* ... */ });

app.post('/generate', {
  preHandler: app.mppGated({ scope: 'gen:1', amount: 50_000n, intent: 'charge' }),
}, async (req) => {
  const payer = req.payer;  // verified, typed Hex
  return await yourBusinessLogic(req.body, payer);
});
```

No Redis required for dev (in-memory store default). No DB. No state. Just auth + payment for your existing endpoint.

### Path B — Scaffold: start a new service from scratch

You want a complete MPP service with the full stack wired up. Run the CLI, answer prompts, get a working repo:

```bash
npx @zeroclickai/paywrap-cli create my-service
# answers: intent (charge/session), price, scope, framework, storage, queue, hosting
# generates: package.json, Fastify app, mppx setup, optional Drizzle + BullMQ, Dockerfile, tests
# runs: pnpm install, biome autofix, generates a wallet
cd my-service
pnpm dev
```

Working 402 on your laptop in ~3 minutes. Fill in the TODO-marked business logic and ship.

**When to use which:** Path A for "my API already exists, charge for it." Path B for "I want the full session service with DB + worker + reaper crons" (e.g. the Redis-as-a-service reference integration).

---

## Package map (current state)

All packages live in `packages/` with pnpm workspace linking.

| Package | Path | Role | Tests | Stability |
|---|---|---|---|---|
| `@zeroclickai/paywrap` | `packages/kit/` | Framework-agnostic primitives: mppx config, verifyWithScope, signing, crypto, manifest, health, setup, stores (memory / redis / workers-kv) | 74 | Core — API surface stabilizing |
| `@zeroclickai/paywrap-adapter-fastify` | `packages/adapters/fastify/` | Fastify middleware (`mppGated`), 402 response helpers, preconfigured app factory | 18 | Stable, both reference consumers use it |
| `@zeroclickai/paywrap-adapter-hono` | `packages/adapters/hono/` | Same capability as Fastify adapter but for Hono. Runs on Cloudflare Workers. | 22 | Shipped, no production consumer yet |
| `@zeroclickai/paywrap-cli` (`bin: paywrap`) | `packages/cli/` | Interactive scaffolder + ops commands (generate-wallet, generate-secrets, prefund, check) | 17 | Functional, light polish pending |

Not yet shipped:
- `@zeroclickai/paywrap-client` — buyer SDK (`createPayingFetch`). Highest-priority roadmap item.
- `@zeroclickai/paywrap-adapter-express` — trivial mirror, waiting for real demand.
- Durable-Object store for linearizable session-voucher accounting on Workers.

## Architecture (how the pieces fit)

```
┌─────────────────────────────────────────────────────────────┐
│ Seller's service (Fastify / Hono / whatever)                │
│   └─ adapter.mppGated({...}) preHandler                     │
│         └─ @zeroclickai/paywrap-adapter-{fastify,hono}          │
│               └─ challenges.ts, gated.ts, app.ts            │
└───────────┬─────────────────────────────────────────────────┘
            │ uses
            ▼
┌─────────────────────────────────────────────────────────────┐
│ @zeroclickai/paywrap (the kit)                                   │
│                                                              │
│ /mpp          — createPaywrapMpp, Tempo chain + constants,   │
│                 stores (memory/redis/workers-kv),            │
│                 closeSessionOnChain, verifyWithScope,        │
│                 assertVoucherAdvances                        │
│                                                              │
│ /auth         — payerFromCredential, claimedPayerFromRaw...,│
│                 extractCredential, buildXxxChallenge,        │
│                 VerifiedCredential (branded)                 │
│                                                              │
│ /signing      — signVoucher, buildVoucherCredential,         │
│                 buildChargeCredential                        │
│ /crypto       — AES-256-GCM encryptSecret/decryptSecret      │
│ /manifest     — buildPaywrapJson (.well-known/paywrap.json)  │
│ /health       — aggregateHealthProbes                        │
│ /setup        — generateWallet, generateMppSecretKey,        │
│                 prefundWallet                                 │
│ /testing      — seedChannel, stubVerifyCredential            │
└───────────┬─────────────────────────────────────────────────┘
            │ consumes
            ▼
         mppx@0.6.x (upstream library — Tempo MPP protocol)
```

`paywrap-cli` is a separate tree — it consumes both the kit and the fastify adapter via templates. Its scaffolder is independent of the runtime kit.

---

## Design principles (non-negotiable without explicit discussion)

1. **`paywrap` is the umbrella, not the protocol.** The package is named for what it does (wrap a payment around a request), not for what protocol it currently uses. v1 covers MPP; x402 support lands in `packages/kit/src/x402/` when we build it. We do not rename to `mpp-kit`.

2. **Framework-agnostic kit + optional adapters.** The kit returns `{status, headers, body}` descriptors, never HTTP responses. Adapters map those descriptors onto each framework's API. This is why we can ship Fastify + Hono without code duplication and why Express/Elysia/etc. are each <150 LOC.

3. **Security contracts enforced by types, not comments.** `VerifiedCredential` is a branded type; the only way to get one is `verifyWithScope(mppx, cred, scope)`. Forgetting to verify is a compile error. Same rigor applies for future primitives.

4. **Services built on paywrap can be stateless.** Charge-intent services have no inherent need for their own database; the upstream provider (Netlify, Redis Cloud, etc.) is the source of truth. The kit supports stateful services (session intent, wallet concurrency caps) but does not require them.

5. **In-memory is the default, Redis is opt-in.** The kit should not demand infrastructure for a dev-mode service. `createPaywrapMpp({})` works; adding `REDIS_URL` graduates to the Redis-backed store.

6. **Honest about failure modes.** Workers KV is not atomic; we document it loudly and ship it anyway because it's useful. `node:util` in mppx requires `nodejs_compat` on Workers; we document it. We do not pretend limitations away.

7. **The CLI does one thing.** `paywrap create` scaffolds. `paywrap generate-wallet`, `generate-secrets`, `prefund`, `check` are ops commands. It is not a framework. It does not dictate how your service evolves.

8. **No barrel files in the kit.** Per project style, consumers import from subpaths (`@zeroclickai/paywrap/mpp`). There is no `@zeroclickai/paywrap` root index.

9. **Lift when duplicated.** If a pure utility lives in an adapter, move it to the kit and re-export. `extractCredential` is in `/auth` now because both adapters need it. Same rule going forward.

10. **Primitives, not opinions about infrastructure.** The kit does not impose architectural choices — no required queue, no required database, no required framework, no required concurrency model. A service can run on Fastify + Postgres + BullMQ, or Hono + Workers KV + in-process fire-and-forget, or Express + DynamoDB + cron triggers. The kit's `createPaywrapMpp` + adapters + security primitives work the same across all of them. **Paywrap never says "you need Redis for durability" or "you need a DB for idempotency" — services pick what fits their operational trade-offs.** The CLI ships defaults for common setups (Fastify + optional Postgres + optional BullMQ) but every toggle is `none`-able.

---

## What's in scope / not in scope

### In scope for the monorepo
- MPP primitives (and x402 primitives when we add them)
- Framework adapters (Fastify, Hono; Express on demand)
- CLI for scaffolding + ops
- Buyer SDK (`@zeroclickai/paywrap-client`) — not yet shipped
- Documentation + reference examples
- Store adapters (memory, Redis, Workers KV; Durable Objects later)

### Not in scope (belongs in each consumer)
- Business logic
- Database schemas / models (if the service needs its own DB at all)
- Queue jobs (reaper, orphan-sweep, etc.)
- Host configs (Dockerfile, render.yaml, fly.toml, wrangler.toml *except as an example in the adapter README*)
- Deployment runbooks
- Specific domain state machines

### Deferred (may revisit)
- Publishing to npm — waiting on product maturity
- Durable-Object store for linearizable sessions on Workers
- Event-sourced / append-only persistence models
- Per-buyer bandwidth / quota tracking (a product concern, not a kit concern)

---

## Current reference consumers

Two external repos consume paywrap via `file:` dep (not yet via npm):

| Repo | Intent | Use case | Status |
|---|---|---|---|
| `../zero-redis-integration/` | session | Redis Cloud DB provisioning for agents. Stateful, DB-backed, session-voucher close cron. | Deployed to Render, 66/66 tests green |
| `../zero-netlify-integration/` | charge | Netlify static site deploys for agents. Fully stateless (Netlify API is source of truth), idempotent-by-name, POST /v1/deploys uses `mppGated.preCheck` for name collision. | Committed, 70/70 tests green, not yet deployed |

Both services should remain the canonical "what a real consumer looks like" references. They are not starter templates — `paywrap create` is.

---

## Glossary

- **MPP (Machine Payments Protocol)** — the spec paywrap currently supports. Tempo is the L1 settlement chain.
- **x402** — the protocol name for payments-over-HTTP-402, a broader spec. Future paywrap protocol target.
- **session intent** — multi-request payment channel. Buyer opens a channel with a deposit; vouchers accumulate cumulative amount; seller closes at end. Amortizes open-gas across many requests.
- **charge intent** — single-shot payment. Buyer signs a Tempo transaction, seller broadcasts it as-is, mppx confirms on-chain. Buyer's USDC pays both price and gas via `feeToken: USDC`. **Seller wallet does NOT need USDC funding** — the seller is just a signer (for HMAC-bound challenges) + recipient. This differs from session intent, where the seller submits `openChannel`/`closeChannel` and therefore needs USDC for gas on those calls.
- **proof credential** — charge credential with `amount: "0"`. Proves a wallet signed a scope-bound challenge without moving funds. Used for wallet-auth'd read/delete routes.
- **voucher** — a signed EIP-712 object in a session channel committing to a `cumulativeAmount`. Settled on close.
- **scope** — a string the seller binds to every paid challenge. HMAC-bound into the challenge id; prevents replay of a credential signed for one route against a different route.
- **VerifiedCredential** — branded type that can only be produced by `verifyWithScope`. Encodes "this credential passed full verification against expected scope" in the type system.
- **Tempo** — the L1 we transact on. Chain id 4217. USDC contract at `0x20C0...8b50`. Escrow at `0x33b9...4f25`.
- **feeToken** — a Tempo-specific chain config field (`feeToken: USDC`) that routes gas payment through USDC balance instead of a native token. Lets a service wallet hold only USDC.
- **`Payment <b64>` header** — the serialized wire format for a credential. `Credential.serialize` (and by extension `buildVoucherCredential` / `buildChargeCredential` from `@zeroclickai/paywrap/signing`) returns the FULL Authorization header value including the `Payment ` prefix. Pass the return value verbatim as `authorization: <result>` — do NOT wrap it in another `"Payment "`.

---

## Roadmap themes (directional, not a todo list)

**Next most likely:**
- Buyer SDK (`@zeroclickai/paywrap-client`) with `createPayingFetch` — the last piece before external sellers can expect buyers to consume them cleanly
- Durable-Object store adapter — unblocks session-intent services on Workers at real concurrency
- x402 primitives in `packages/kit/src/x402/` — parallel to MPP, same shape

**If demand surfaces:**
- Express adapter
- Elysia / Bun.serve adapter
- `paywrap add-gated-route` CLI for adding MPP to an existing project (vs scaffolding new)
- Test-mode facilitator — deterministic signer + in-memory chain for downstream integration tests

**Explicitly not:**
- A generic "paid resource CRUD" higher-order helper. Premature; we have one data point.
- Kit-internal DB or queue abstractions. Services bring their own.
- A hosted Zero-operated version of paywrap. This is a library, not a SaaS.

---

## How we work on this

- Every change: tests + typecheck + lint green before commit on `main` (no push without explicit approval)
- Every kit API change: consider the brand/type-enforcement angle first (see principle #3)
- Every bug in a consumer that would have been prevented by a kit primitive: the primitive goes in the kit (see principle #9)
- Every new framework adapter: mirror the Fastify/Hono shape (`mppGated` + `sendXxxChallenge` + `createXxxApp`), lift pure utilities to the kit

## Where to look next

- `packages/kit/README.md` — quickstart (both paths) + subpath import table
- `packages/adapters/hono/README.md` — Cloudflare Workers deployment notes + KV store caveats
- `../zero-redis-integration/docs/learnings.md` — the hard-won gotchas from the first production integration
- `../zero-netlify-integration/docs/learnings.md` — the stateless-service reference pattern
