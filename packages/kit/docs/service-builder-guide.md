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

## Payment Methodologies

Choose the payment pattern that matches how your service creates value.

### 1. Charge-Based: Pay Once Per Call

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

- buyer pays gas by default,
- seller wallet receives settlement,
- invalid requests should be rejected in `preCheck` before settlement,
- post-settlement upstream failures should emit the standard `paywrap_refund_owed` log shape.

### 2. Session-Based: Prepaid Channel For Repeated Calls

Use `intent: "session"` when a buyer should open a channel and spend against it over one or more calls.

Best for:

- repeated API calls in one task,
- low-latency calls where opening a payment every time is too expensive,
- services where the seller may close the channel after work completes.

```ts
app.post(
	"/v1/search",
	mppGated({
		scope: "search:v1",
		intent: "session",
		amount: 500n,
		suggestedDeposit: 10_000n,
		unitType: "request",
	}),
	async (c) => c.json(await search(c.var.payer)),
);
```

Properties:

- seller pays gas for open/close operations and should prefund the seller wallet,
- each voucher advances cumulative spend,
- Redis or another durable store is recommended for multi-replica Node services,
- Workers KV is useful for charge intent and low-concurrency session use, but is not atomic for high-concurrency vouchers.

### 3. Metered: Authorize A Maximum, Bill The Actual

Use `mppMetered` when the final price is only known after execution, but the buyer can authorize a maximum upfront.

Best for:

- audio transcription billed by duration,
- LLM calls billed by tokens,
- document processing billed by pages,
- any route where input size or upstream usage controls final cost.

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
		c.var.settle(BigInt(result.costUsdcMicro));
		return c.json(result);
	},
);
```

Properties:

- buyer authorizes up to `maxAmount`,
- handler must call `c.var.settle(actualAmount)` before returning,
- response includes a `Payment-Receipt` header for the actual amount,
- if the handler forgets to call `settle`, the middleware falls back to `maxAmount` and logs that fallback,
- server-side recovery helpers can persist and retry buyer-signed close vouchers.

Use metered billing only when your client flow understands the receipt/close step. For simple fixed-price APIs, charge-based routes are easier.

### 4. Charge Upfront, Then Use Proof For Validated Access

Use this pattern when payment creates a right to access something later, and later calls should verify wallet identity without charging again.

Best for:

- paid creation followed by free polling,
- paid job submission followed by result download,
- paid sandbox creation followed by status or control calls,
- any workflow where the first call pays and subsequent calls need payer validation.

The first call is a normal charge:

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

Follow-up calls can require proof credentials:

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

- first call settles money,
- proof calls are zero-amount wallet authentication,
- no on-chain activity is required for proof,
- you must store the payer/owner relationship from the paid call,
- use separate scopes for creation and read/control access.

## Choosing A Pattern

| Pattern | Use When | Buyer Pays | Seller Pays | Main Risk |
|---|---|---|---|---|
| Charge-based | Price is known before work | Request amount + gas by default | Nothing by default | Charging for bad inputs if you skip `preCheck` |
| Session-based | Many calls share one channel | Vouchers against deposit | Open/close gas | Store consistency under concurrency |
| Metered | Actual price is known after work | Actual usage up to max | Close/retry operations | Handler must settle correctly |
| Charge + proof | Payment grants later access | Upfront charge | Nothing for proof | You must persist ownership correctly |

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
