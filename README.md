# zero-paywrap

Toolkit for building paid API services on-chain. v1 covers MPP (channel-based session/charge payments on Tempo). Designed so x402 support can slot in later without changing consumers.

## Packages

| Package | Purpose |
|---|---|
| `@zerorun/paywrap` | Core primitives — payment verification, signing, crypto, stores, manifest + health builders |
| `@zerorun/paywrap-adapter-fastify` | Optional Fastify adapter (`packages/adapters/fastify/`) — 402 challenge-reply helpers, credential extractor, preconfigured app factory |
| `@zerorun/paywrap-adapter-hono` | Optional Hono adapter (`packages/adapters/hono/`) — runs on Cloudflare Workers, Node, Bun. See [Persistent state on Workers](./packages/adapters/hono/README.md#persistent-state-on-workers) for the KV-backed store. |
| `@zerorun/paywrap-cli` (bin: `paywrap`) | Interactive setup CLI + day-2 ops commands |

## Scope

**In the kit:** framework-agnostic primitives — `createMppx`, `verifyCredential`, `signVoucher`, AES-256-GCM helpers, ChannelStore adapters, close-on-chain helper, `buildPaywrapJson`, `aggregateHealthProbes`, `generateWallet` + setup utilities.

**Not in the kit:** host configs (Dockerfile/render.yaml/fly.toml), DB models, queue layer, state machines, business logic. Those belong in each service repo.

## Naming

`paywrap` is the umbrella — current protocol is `mpp` (`packages/kit/src/mpp/`), future `x402` slots in alongside. Shared primitives (`auth`, `signing`, `crypto`) live at the top level.

## Examples

`examples/` links reference implementations — starting with `zero-redis-integration` once migrated to consume the kit. Each example is a full working MPP service on a specific host; read them for patterns, don't fork them as starters. For a new service, use `npx @zerorun/paywrap-cli create`.
