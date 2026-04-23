# CLAUDE.md — paywrap

Auto-loaded context for agents working in this repo. Keep it short; full detail lives in `docs/`.

## What this is

`paywrap` is a toolkit for putting MPP-gated 402s in front of HTTP APIs. v0.0.1 ships MPP on Tempo; `x402` is the next protocol and will land in `packages/kit/src/x402/` without breaking MPP consumers.

Four packages published to npm under `@zeroclickai/*`:

- `@zeroclickai/paywrap` — framework-agnostic kit (`packages/kit/`)
- `@zeroclickai/paywrap-adapter-fastify` — Fastify middleware (`packages/adapters/fastify/`)
- `@zeroclickai/paywrap-adapter-hono` — Hono middleware, Workers-safe (`packages/adapters/hono/`)
- `@zeroclickai/paywrap-cli` (bin: `paywrap`) — scaffolder + ops commands (`packages/cli/`)

Two consumer repos live as siblings: `../zero-redis-integration/` (session intent, deployed) and `../zero-netlify-integration/` (charge intent, local-only).

## Read first

- `docs/overview.md` — product + architecture overview with design principles
- `docs/next-steps.md` — current state snapshot + ranked next steps + known gotchas + resume playbook
- `packages/kit/src/mpp/mppx.ts` — the primitive everything else orbits (`createPaywrapMpp`)
- `packages/kit/src/mpp/verify.ts` — `verifyWithScope` is the ONLY safe credential verify path (sole factory for the branded `VerifiedCredential` type)

## Non-negotiable principles (don't change without explicit discussion)

1. **`paywrap` is the umbrella, not the protocol.** Don't rename to `mpp-kit`; x402 is coming.
2. **Framework-agnostic kit + optional adapters.** Kit returns `{status, headers, body}` descriptors, never HTTP responses. Adapters map onto framework APIs.
3. **Security contracts enforced by types, not comments.** `VerifiedCredential` is branded; only `verifyWithScope` produces one.
4. **Services built on paywrap can be stateless.** Charge-intent doesn't require a DB; upstream provider is the source of truth.
5. **In-memory default store; Redis + Workers KV are opt-in.** `createPaywrapMpp({})` should just work for dev.
6. **Honest about failure modes.** Workers KV is not atomic — we document it, we don't pretend. Same for `mppx` pulling `node:util` on Workers (needs `nodejs_compat`).
7. **No barrel files in the kit.** Consumers import from subpaths (`@zeroclickai/paywrap/mpp`, `/auth`, `/signing`, etc.). No root barrel export exists — deliberate.
8. **Lift when duplicated.** If a pure utility lives in an adapter, move it to the kit and re-export from both adapters.

9. **Primitives, not opinions about infra.** The kit doesn't impose a queue, DB, framework, or concurrency model on services. A charge-intent service might run fire-and-forget in-process; a high-throughput session service might use BullMQ. Both are valid. Don't bake "you need Redis" assumptions into the kit or the scaffold defaults beyond documenting the option.

## How to work here

- **Before committing:** `pnpm -r --filter '!./examples/*' typecheck && pnpm -r test && pnpm -w lint` must be green.
- **Commits:** small, logical. One commit per change area, not batch cleanup dumps.
- **Branches:** work on `main` for small changes; feature branches + PRs for non-trivial work. Per user memory, never push directly to main on consumer repos — they auto-deploy via Render.
- **Tests:** no facetious mocks (per project feedback memory). Use real in-memory stores (`memoryStore()`, PGlite, FakeNetlifyClient shaped at the interface) rather than deep-mocking `fetch` or lower primitives.
- **Comments:** prefer WHY comments explaining non-obvious constraints. Delete comments that restate what the code does. Keep references to chain IDs, EIP-712 domains, contract addresses — those are load-bearing for readers.
- **Subagents:** Opus only. Never downgrade (per user memory). Parallelize when work is independent; don't serially dispatch what could run concurrently.

## Known gotchas (see `docs/next-steps.md` for the full list)

- `feeToken: USDC` is tempo-chain-specific and viem's base `Chain` type doesn't know about it — the kit casts `tempoChain` to `any` for this reason.
- `MppxInstance = any` is load-bearing — mppx's inferred types explode in `.d.ts`.
- `node:util` from mppx requires `nodejs_compat = true` in `wrangler.toml` for Workers consumers.
- Workers KV is NOT linearizable; the store adapter documents this loudly. Safe for charge-intent, unsafe for high-concurrency session.
- `tempo.charge.verify()` settles on-chain atomically during verify — reversed-order route logic risks paying without delivering.

## Publishing

Packages publish via `pnpm -r --filter '!./examples/*' publish --access public --no-git-checks`. Requires a granular npm access token with "Bypass 2FA for publishing" enabled. Token lives in a repo-local `.npmrc` (gitignored). `chmod 600` it. Delete after publishing unless actively iterating.

## Current state

See `docs/next-steps.md` — always up-to-date snapshot of what's on npm, what's deployed, what's next.
