# Service Builder Guide

This guide is for anyone turning an existing API capability into a paid service that agents can discover, pay for, and call.

The goal is simple:

1. expose a normal HTTP endpoint,
2. put a payment gate in front of it,
3. publish discovery files so indexers know what it costs and how to call it,
4. list the deployed service on Zero,
5. log enough settlement/refund data to operate it safely.

## Two Development Models

Paywrap supports two equally valid ways to build.

### Model A: Add Paywrap To An Existing API

Use this when you already have a service, route handlers, auth, logging, or upstream clients.

You install the kit plus an adapter, bootstrap the payment context, and add a route-level gate:

```ts
import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { createPaywrapMpp, workersKvStore } from "@zeroclickai/paywrap/mpp";

const app = createHonoApp<{ Bindings: Env }>((c) => {
	const mpp = createPaywrapMpp({
		walletPrivateKey: c.env.WALLET_PRIVATE_KEY as `0x${string}`,
		mppSecretKey: c.env.MPP_SECRET_KEY,
		publicBaseUrl: c.env.PUBLIC_BASE_URL,
		tempoRpcUrl: c.env.TEMPO_RPC_URL,
		store: workersKvStore(c.env.PAYWRAP_KV),
	});
	return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
});

app.post(
	"/v1/render",
	mppGated({ scope: "render:v1", intent: "charge", amount: 1000n }),
	async (c) => c.json({ result: "paid work" }),
);
```

This is the right model for Cloudflare Workers, Fastify, Hono, Bun, or Node services that already exist.

### Model B: Start From The Paywrap Scaffold

Use this when you want a complete service skeleton with env parsing, routes, health checks, manifest routes, storage choices, and setup scripts.

```sh
npx @zeroclickai/paywrap-cli create my-service
cd my-service
pnpm dev
```

The scaffold asks for framework, payment intent, price, scope, storage, queue, and hosting choices. Business logic is isolated behind `TODO(paywrap)` markers so you can replace the demo handler with your real capability.

Start from the scaffold when you want the fastest path to a deployable service. Add Paywrap to an existing API when you already have an app shape you trust.

## Discovery: OpenAPI And 402 Headers

Every service should expose:

- `GET /openapi.json`
- real `402 Payment Required` responses from paid routes when no valid payment credential is provided

OpenAPI is the public discovery document implementors already understand. Add payment metadata directly to each paid operation with `x-payment-info`, and include a `402` response. The live route must also advertise the payment requirement through its actual 402 headers, for example `WWW-Authenticate: Payment ...`.

Paywrap provides a small `PaywrapManifest` helper because it is a convenient internal source of truth for route pricing. Pass it to `buildOpenApiSpec` to emit the public discovery document.

```ts
import { buildOpenApiSpec } from "@zeroclickai/paywrap/manifest";

const manifest = {
	wallet: "0xSellerSettlementAddress",
	paidRoutes: [
		{
			method: "POST",
			path: "/v1/render",
			protocol: "mpp" as const,
			sku: "render:v1",
			priceUsdcMicro: "1000",
			pricingVersion: 1,
			description: "Render input to SVG bytes.",
			requestContentType: "application/json",
			responseContentType: "image/svg+xml",
		},
	],
	freeRoutes: [
		{ method: "GET", path: "/openapi.json" },
		{ method: "GET", path: "/healthz" },
	],
};

app.get("/openapi.json", (c) =>
	c.json(
		buildOpenApiSpec(
			manifest,
			{ title: "Render Service", version: "1.0.0" },
			{ serverUrl: c.env.PUBLIC_BASE_URL },
		),
	),
);
```

`buildPaywrapJson` from the same subpath exists for internal Paywrap-specific tooling; OpenAPI plus the live `402` is the public contract and is sufficient for indexers.

The generated OpenAPI marks paid routes with `x-payment-info`:

```json
{
	"x-payment-info": {
		"method": "tempo",
		"currency": "USDC",
		"amount": "0.001",
		"sku": "render:v1",
		"pricingVersion": 1
	},
	"responses": {
		"200": { "description": "Successful response after payment" },
		"402": { "$ref": "#/components/schemas/PaymentRequired" }
	}
}
```

At runtime, the route itself is the source of truth. A request without a payment credential should return `402` with a payment challenge header. OpenAPI helps agents discover what will happen; the 402 challenge tells them exactly what to sign.

## Listing On Zero

After deployment, submit the service origin to Zero's registrar:

```sh
curl -X POST "https://api.zero.xyz/v1/register" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://your-service.example.com",
    "protocol": "mpp"
  }'
```

Use `"protocol": "x402"` for x402 services. The `url` should be the public base URL, not `/openapi.json` and not an individual paid route.

Zero crawls the base URL and probes `/openapi.json` to enumerate capabilities. Make sure the OpenAPI document is live, includes every paid operation, and marks each paid operation with `x-payment-info` plus a `402` response before registering. The route itself must also return a real payment challenge header when called without credentials.

See [List Your Service On Zero](./list-on-zero.md) for the full registration guide, OpenAPI schema example, preflight checks, and troubleshooting table.

## Payment Options At A Glance

Pick the option that matches how your service creates value, then jump to its detailed section below.

| Option | Use when | Buyer pays | Seller wallet | Main risk |
|---|---|---|---|---|
| [Charge-based](#charge-based-detail) | Price is known before work; each request stands alone | Amount + gas (in USDC) | Receive only — no funding | Charging for bad inputs without `preCheck` |
| [Session-based](#session-based-detail) | Many calls share one prepaid channel | Vouchers against deposit | Must hold ~$0.05 USDC for open/close gas | Store consistency under concurrency |
| [Metered](#metered-detail) | Final price is only known after work | Actual usage up to authorized max | Pays gas on close (USDC) | Handler must call `settle(actual)` |
| [Charge + proof](#charge--proof-detail) | First call pays for an artifact; later calls re-authenticate the payer | Upfront charge; proof calls are free | Receive only — no funding | Must persist payer/owner ownership |

One-liner per option (full examples below):

```ts
// Charge — fixed price, atomic
mppGated({ scope: "render:v1", intent: "charge", amount: 1000n })

// Session — prepaid channel, many calls
mppGated({ scope: "search:v1", intent: "session", amount: 500n, suggestedDeposit: 10_000n })

// Metered — authorize max, bill actual
mppMetered({ scope: "transcribe:v1", maxAmount: 200_000n })

// Proof — wallet auth only, zero-amount
mppGated({ scope: "job-read:v1", intent: "proof" })
```

> **If you're not sure, start with charge-based.** It's the easiest to reason about, easiest to register on Zero, and easiest for agents to call. Switch later only if your billing shape actually demands it.

## Detailed Patterns

The rest of this section is reference material for whichever option you've picked. Skip to the one that matches.

### Charge-based — detail
<a id="charge-based-detail"></a>

Use `intent: "charge"` when the price is known before execution and each request stands alone.

Best for:

- rendering a diagram,
- translating a text snippet,
- generating one image,
- proxying a fixed-price upstream endpoint.

```ts
app.post(
	"/v1/render",
	mppGated({
		scope: "render:v1",
		intent: "charge",
		amount: 1000n, // micro-USDC
		meta: { sku: "render:v1", pricingVersion: "1" },
		preCheck: async ({ c }) => {
			const body = await c.req.json().catch(() => null);
			if (!body || typeof body.input !== "string") {
				return { ok: false, status: 400, body: { error: "invalid_body" } };
			}
			return { ok: true };
		},
	}),
	async (c) => c.json(await doFixedPriceWork(c.var.payer)),
);
```

Properties:

- buyer pays gas by default — the buyer signs a Tempo tx with `feeToken: USDC` and the seller broadcasts it as-is,
- seller wallet only needs to be a signer + recipient; **no USDC funding required**,
- invalid requests should be rejected in `preCheck` before settlement,
- post-settlement upstream failures should emit the standard `paywrap_refund_owed` log shape (see [Operations Guide](./operations.md)),
- use `keyless` mode (`createPaywrapMpp({ walletAddress })`) — no private key in the runtime.

### Session-based — detail
<a id="session-based-detail"></a>

Use `intent: "session"` when a buyer opens a channel with a deposit and spends against it across many calls. The seller submits one `openChannel` tx (when the buyer pays), accepts vouchers as cumulative-amount commitments, and submits one `closeChannel` tx at the end. Open/close gas is amortized across every call inside the session.

Best for:

- repeated API calls in one task (search, retrieval, agentic loops),
- low-latency calls where the round-trip cost of a fresh charge tx every time is too high,
- services where the seller naturally knows when "work is done" and can close the channel.

#### 1. Bootstrap with a private key

Session intent requires a signer (the seller submits open/close txs themselves). Switch from address-only to keyed mode and prefund the wallet:

```sh
paywrap generate-wallet     # prints address + private key
paywrap prefund <address>   # tops up ~$0.05 USDC on Tempo
```

```ts
import { createPaywrapMpp, redisStore } from "@zeroclickai/paywrap/mpp";

const mpp = createPaywrapMpp({
	walletPrivateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
	mppSecretKey: process.env.MPP_SECRET_KEY!,
	publicBaseUrl: process.env.PUBLIC_BASE_URL!,
	tempoRpcUrl: "https://rpc.tempo.xyz",
	store: redisStore({ url: process.env.REDIS_URL! }), // see store callout below
});
```

#### 2. Gate the route

```ts
app.post(
	"/v1/search",
	mppGated({
		scope: "search:v1",
		intent: "session",
		amount: 500n,           // micro-USDC charged per voucher advance
		suggestedDeposit: 10_000n, // hint to the buyer for channel opening
		unitType: "request",
	}),
	async (c) => c.json(await search(c.var.payer)),
);
```

Each call advances `cumulativeAmount` on a stored voucher; the kit enforces monotonic advance via `assertVoucherAdvances` so a stale voucher can't replay.

#### 3. Close the channel and settle on-chain

When the buyer signals "I'm done" (an explicit close endpoint, an idle timeout, or a reaper cron), submit the highest voucher on-chain to release the seller's earned USDC:

```ts
import { closeSessionOnChain } from "@zeroclickai/paywrap/mpp";

app.post(
	"/v1/sessions/:channelId/close",
	mppGated({ scope: "session-close:v1", intent: "proof" }),
	async (c) => {
		const channelId = c.req.param("channelId") as `0x${string}`;
		const result = await closeSessionOnChain(mpp, channelId);
		// result: { status: "closed", txHash } | { status: "skipped", reason }
		return c.json(result);
	},
);
```

`closeSessionOnChain` is idempotent — already-finalized channels and benign on-chain races (channel gone, already-settled) return a `skipped` status instead of throwing. Pair it with a daily reaper that closes any session idle for more than N hours so abandoned channels don't sit forever.

#### Store choice

| Runtime | Store | Notes |
|---|---|---|
| Single-node dev | `memoryStore()` (default) | Fine for laptops; loses state on restart. |
| Multi-replica Node | `redisStore({ url })` | Required — voucher accounting is shared state. |
| Cloudflare Workers, low concurrency | `workersKvStore(env.KV)` | Acceptable when one buyer owns one channel and concurrent voucher writes are rare. KV is **not** linearizable; concurrent voucher updates on the same channel can corrupt `cumulativeAmount`. |
| Cloudflare Workers, high concurrency | Durable Objects (not yet shipped) | Until the DO store lands, run session-intent on Node + Redis. |

Properties:

- seller pays gas for open/close txs (USDC via `feeToken: USDC`),
- each voucher advances cumulative spend; the kit rejects non-advancing replays,
- voucher state lives in the channel store — choose durability that matches your concurrency,
- closing is idempotent — safe to call from a route, a reaper, and a `waitUntil` hook.

#### Refunds in session intent: just don't bill the failed call

Because the buyer's deposit sits in **escrow** (not the seller wallet) until close, the natural-refund mechanism is "close at a lower amount." The escrow contract automatically refunds `deposit - cumulativeAmount` to the buyer in the same `close()` tx — no separate refund tx needed.

To opt into per-call automatic rollback when the handler throws, pass `refundOnFailure: true`:

```ts
app.post(
	"/v1/search",
	mppGated({
		scope: "search:v1",
		intent: "session",
		amount: 500n,
		refundOnFailure: true, // ← roll back the voucher on handler throw
	}),
	async (c) => {
		const result = await upstream.search(c.var.payer); // may throw
		return c.json(result);
	},
);
```

How it works: before verify, the middleware reads the channel's current `highestVoucher`. After verify advances it to include the new call's amount, the handler runs. If the handler throws (or `c.error` is set), the middleware writes the prior voucher back to the channel store. When the seller eventually calls `closeSessionOnChain`, it submits the rolled-back voucher — and the escrow contract refunds the failed call's amount to the buyer along with the rest of the unspent deposit.

Constraints (the rollback helper enforces these and silently no-ops if violated):

- **Channel must not be finalized.** If close already submitted, rollback is a no-op.
- **Cannot roll back below `settledOnChain`.** If the seller has called `settle()` mid-channel, the rollback target must be `>= settledOnChain` — otherwise the eventual `close()` would revert with `AmountNotIncreasing`. The helper guards against bricking the channel.
- **Tail-only granularity.** Rollback affects the most recent voucher only. You cannot refund a call from the middle of a session — vouchers are monotonic and you only have valid signatures for points the buyer ratified.

For deliberate (non-throwing) refund decisions — content moderation, post-success policy violations, audit reversals — call the primitive directly:

```ts
import { rollbackSessionVoucher } from "@zeroclickai/paywrap/mpp";

await rollbackSessionVoucher(mpp.channelStore, channelId, priorSignedVoucher);
```

Has no effect for charge or proof intent — `refundOnFailure: true` is a quiet no-op for those because charge already settled atomically (use `refundCharge` instead) and proof moves no money.

### Metered — detail
<a id="metered-detail"></a>

Use `mppMetered` when the buyer can authorize a maximum upfront but the actual price is only known after the work runs. The buyer signs an open voucher for `maxAmount`; your handler computes the real cost, calls `settle(actual)`, and the middleware emits a `Payment-Receipt` header. The buyer countersigns a close voucher at `actual`, your service persists it, and a reaper submits it on-chain.

Best for:

- audio transcription billed by duration,
- LLM calls billed by tokens,
- document processing billed by pages,
- any route where input size or upstream usage controls final cost.

#### 1. Gate the route

```ts
import { mppMetered } from "@zeroclickai/paywrap-adapter-hono";

app.post(
	"/v1/transcribe",
	mppMetered({
		scope: "transcribe:v1",
		maxAmount: 200_000n,
		meta: { sku: "transcribe:v1", pricingVersion: "1" },
	}),
	async (c) => {
		const result = await transcribe(await c.req.arrayBuffer());
		c.var.settle(BigInt(result.costUsdcMicro)); // bill the actual
		return c.json(result);
	},
);
```

If the handler forgets to call `settle` on a successful response, the middleware falls back to billing `maxAmount` and logs `payment_metered_settled` with `fallback: true` — the buyer is over-billed but the channel still closes. Always call `settle`. If the response fails (`status >= 400`) or the handler throws before settling, the middleware closes at `0` instead so validation and upstream failures do not consume payment by default.

#### 2. Persist the close voucher when the buyer countersigns

The buyer's CLI POSTs a close voucher to whichever endpoint your service exposes. Persist it onto the channel state so a later reaper can submit it even after a Worker tear-down or RPC blip:

```ts
import { persistMeteredCloseVoucher } from "@zeroclickai/paywrap/mpp/metered";

app.post(
	"/v1/sessions/:channelId/close",
	mppGated({ scope: "transcribe-close:v1", intent: "proof" }),
	async (c) => {
		const { cumulativeAmount, signature } = await c.req.json();
		await persistMeteredCloseVoucher(mpp.channelStore, c.req.param("channelId") as `0x${string}`, {
			channelId: c.req.param("channelId") as `0x${string}`,
			cumulativeAmount: BigInt(cumulativeAmount),
			signature,
		});
		return c.json({ ok: true });
	},
);
```

#### 3. Submit on-chain from a reaper

A cron / scheduled-event handler reads the persisted voucher and submits at the actual amount. This is the metered analog of `closeSessionOnChain` — same shape, but settles at `actual` not `maxAmount`:

```ts
import { closeMeteredChannelFromState } from "@zeroclickai/paywrap/mpp/metered";

// e.g. inside a Worker scheduled handler or BullMQ job
const result = await closeMeteredChannelFromState(mpp, channelId);
// { status: "closed", txHash } | { status: "skipped", reason: "no-voucher" | "already-finalized" }
```

If the buyer never POSTs a close voucher (`{status: "skipped", reason: "no-voucher"}`) you have two choices:

- **Wait** — the buyer can recover their full deposit via `escrow.requestClose` (their gas, full refund). Do nothing.
- **Force-close at maxAmount** — call `closeSessionOnChain(mpp, channelId)` explicitly. This bills the buyer the full authorized maximum. Only do this when you're certain the buyer has gone silent and you accept the over-billing.

The kit deliberately does **not** auto-fall-through, because the two paths have different billing semantics and the choice belongs to the seller.

Properties:

- buyer authorizes up to `maxAmount`; final settlement is at `actual`,
- handler must call `c.var.settle(actualAmount)` before returning,
- response includes a `Payment-Receipt` header for the actual amount,
- the persist → reap → close flow survives RPC failures and Worker tear-downs,
- only worth the complexity when your client understands the receipt/close handshake. For fixed-price APIs, charge-based is dramatically simpler.

### Charge + proof — detail
<a id="charge--proof-detail"></a>

Use this pattern when payment creates a right to access something later, and follow-up calls should verify wallet identity without charging again.

Best for:

- paid creation followed by free polling,
- paid job submission followed by result download,
- paid sandbox creation followed by status or control calls,
- any workflow where the first call pays and subsequent calls need payer validation.

The first call is a normal charge — store the payer as the artifact's owner:

```ts
app.post(
	"/v1/jobs",
	mppGated({ scope: "job-create:v1", intent: "charge", amount: 50_000n }),
	async (c) => {
		const job = await createJob({ owner: c.var.payer });
		return c.json({ jobId: job.id, statusUrl: `/v1/jobs/${job.id}` }, 202);
	},
);
```

Follow-up calls require a proof credential — the buyer signs a zero-amount challenge proving they control the same wallet:

```ts
app.get(
	"/v1/jobs/:id",
	mppGated({ scope: "job-read:v1", intent: "proof" }),
	async (c) => {
		const job = await readJob(c.req.param("id"));
		if (job.owner.toLowerCase() !== c.var.payer.toLowerCase()) {
			return c.json({ error: "forbidden" }, 403);
		}
		return c.json(job);
	},
);
```

Properties:

- first call settles money; subsequent proof calls are zero-amount wallet authentication,
- no on-chain activity is required for proof — pure HMAC-bound signature check,
- you must persist the payer/owner relationship from the paid call (your DB / KV),
- use separate scopes for creation, read, and control routes — `job-create:v1`, `job-read:v1`, `job-cancel:v1` — so a credential signed for one route can't be replayed against another.

## Production Checklist

Before registering or advertising a service:

- Serve `/openapi.json` with `x-payment-info` and `402` responses on paid operations.
- Make paid routes return real `402` challenge headers when called without payment.
- Add `/healthz`.
- Use stable `sku` and `pricingVersion` values.
- Validate request bodies in `preCheck` for charge-based routes.
- Use durable state: Redis for Node session services, Workers KV for charge intent and low-concurrency Worker services.
- Pass a `logger` such as `consoleJsonLogger` or a composed sink.
- Never log raw `Payment ...` headers.
- Emit `paywrap_refund_owed` for post-settlement failures that should not bill the buyer.
- Set real `PUBLIC_BASE_URL`, `WALLET_PRIVATE_KEY`, `MPP_SECRET_KEY`, and RPC env vars.
- Smoke test the 402 flow: no credential returns `402`, signed credential returns the paid result.
- Complete the [provider readiness checklist](./list-on-zero.md#provider-readiness-checklist), then register the public base URL with `POST https://api.zero.xyz/v1/register`.

## What To Build First

Start with one charge-based endpoint. It is the easiest to reason about, easiest to register, and easiest for agents to call. Once that is working, add proof routes for follow-up access or metered/session routes for more advanced billing.
