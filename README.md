# zero-paywrap

Toolkit for building agent-callable paid APIs over HTTP. Gate routes with MPP or x402, publish OpenAPI payment metadata, verify payment credentials, and emit structured settlement logs.

## Two ways in

- **Already have an API?** Install the kit + an adapter and drop `mppGated` in front of any route (~10 lines). See [`packages/kit/README.md`](./packages/kit/README.md#path-a--drop-in-to-an-existing-fastify-api).
- **Starting fresh?** `npx @zeroclickai/paywrap-cli create my-service` spins up an interactive scaffold — no install required. See [`packages/cli/README.md`](./packages/cli/README.md).

The CLI is a separate package because it has scaffolder deps (`@clack/prompts`, `commander`, `execa`) that your runtime services shouldn't carry. If you like the `npx` pattern — zero install, one command — you never even touch it as a dependency.

## Packages

| Package | Purpose |
|---|---|
| `@zeroclickai/paywrap` | Core primitives — payment verification, signing, crypto, stores, OpenAPI payment metadata + health builders, settlement logging hooks |
| `@zeroclickai/paywrap-adapter-fastify` | Optional Fastify adapter (`packages/adapters/fastify/`) — 402 challenge-reply helpers, credential extractor, preconfigured app factory |
| `@zeroclickai/paywrap-adapter-hono` | Optional Hono adapter (`packages/adapters/hono/`) — runs on Cloudflare Workers, Node, Bun. See [Persistent state on Workers](./packages/adapters/hono/README.md#persistent-state-on-workers) for the KV-backed store. |
| `@zeroclickai/paywrap-cli` (bin: `paywrap`) | Interactive setup CLI + day-2 ops commands |

## Scope

**In the kit:** framework-agnostic primitives — `createMppx`, `verifyCredential`, `signVoucher`, AES-256-GCM helpers, ChannelStore adapters, close-on-chain helper, `buildPaywrapJson`, `aggregateHealthProbes`, `generateWallet` + setup utilities.

**Not in the kit:** host configs (Dockerfile/render.yaml/fly.toml), DB models, queue layer, state machines, business logic. Those belong in each service repo.

## Naming

`paywrap` is the umbrella — current protocol is `mpp` (`packages/kit/src/mpp/`), future `x402` slots in alongside. Shared primitives (`auth`, `signing`, `crypto`) live at the top level.

## Examples

`examples/` links reference implementations — starting with `zero-redis-integration` once migrated to consume the kit. Each example is a full working MPP service on a specific host; read them for patterns, don't fork them as starters. For a new service, use `npx @zeroclickai/paywrap-cli create`.
