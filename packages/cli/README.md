# @zerorun/paywrap-cli

Interactive scaffolder + day-2 ops commands for [`@zerorun/paywrap`](https://github.com/zeroclickai/zero-paywrap) services.

## Install

```bash
pnpm add -g @zerorun/paywrap-cli
# or one-off: npx @zerorun/paywrap-cli ...
```

Binary: `paywrap`.

## Commands

### Scaffold a new service

```bash
paywrap create my-service
```

Interactive prompts: payment intent (session/charge), price (USDC), scope, duration, HTTP framework, storage, queue, hosting hint, wallet generation, optional prefund for session intent. Generates a working Fastify service (with optional Drizzle + BullMQ), runs `pnpm install`, and leaves a clean repo with TODO markers where your business logic goes.

```bash
paywrap create my-service --yes    # all defaults, non-interactive
```

### Day-2 ops

| Command | Purpose |
|---|---|
| `paywrap generate-wallet` | Print a fresh keypair as `WALLET_PRIVATE_KEY=…` + `WALLET_ADDRESS=…` |
| `paywrap prefund <addr> [--amount-micro N]` | Send USDC on Tempo from `WALLET_PRIVATE_KEY` to `<addr>` (default 50 000 micro = $0.05) |
| `paywrap register` | Publish the deployed service to the Zero catalog via `/v1/register` |
| `paywrap check <url>` | Fetch `<url>/healthz` + `<url>/.well-known/paywrap.json` and pretty-print |

Each ops command reads env from your `.env` (via `dotenv/config`).

## License

MIT.
