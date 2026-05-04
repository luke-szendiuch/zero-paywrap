# Operations Guide

This page covers the production behaviors that matter after a paid route is wired: validation order, refunds, logging, and deployment checks.

For the build flow and payment model decision tree, start with the [Service Builder Guide](./service-builder-guide.md).

## Validate Before Charging

For charge-intent routes, `mppGated` verifies and settles before your handler runs. Put cheap business validation in `preCheck` so malformed or unsupported requests fail before money moves.

```ts
app.post(
	"/v1/things",
	mppGated({
		scope: "thing-create:v1",
		intent: "charge",
		amount: 50_000n,
		preCheck: async ({ c, claimedPayer }) => {
			const body = await c.req.json().catch(() => null);
			if (!body || typeof body.name !== "string") {
				return { ok: false, status: 400, body: { error: "invalid_body" } };
			}
			if (await nameAlreadyExists(body.name, claimedPayer)) {
				return { ok: false, status: 409, body: { error: "name_taken" } };
			}
			c.set("thingInput" as never, body as never);
			return { ok: true };
		},
	}),
	async (c) => {
		const body = c.get("thingInput" as never);
		return c.json(await createThing(body, c.var.payer), 201);
	},
);
```

`claimedPayer` is only a pre-verification hint. Use it for reads and routing decisions, never for irreversible writes.

## Dynamic Pricing

If price comes from env, tenant config, or a route table, build the gate inside middleware so the challenge amount matches runtime config.

```ts
app.post(
	"/v1/render",
	async (c, next) => {
		const price = BigInt(c.env.SKU_PRICE_USDC_MICRO);
		const gate = mppGated({
			scope: "render:v1",
			intent: "charge",
			amount: price,
			meta: { sku: "render:v1", pricingVersion: "1" },
		});
		return gate(c as never, next);
	},
	async (c) => c.json({ ok: true }),
);
```

## Refund-Eligible Failures

When charge intent settles and later work fails, emit a structured refund event. Refunds happen out of band, but a standard shape makes them auditable across services.

```ts
console.error(
	JSON.stringify({
		msg: "paywrap_refund_owed",
		payer: "0xabc",
		sku: "image-gen:v2",
		amountUsdcMicro: "50000",
		reason: "upstream_5xx",
		details: { upstreamStatus: 503 },
		chargeHash: "ff00",
		timestamp: new Date().toISOString(),
	}),
);
```

Use this for post-settlement failures you would not intentionally bill for: upstream `5xx`, upstream rate limits, network timeouts, worker crashes after settlement, and validation that could only happen after a paid side effect began. Do not log refunds for `preCheck` rejections because those happen before settlement.

Never log the raw `Payment ...` header. Include a charge hash or credential fingerprint when available.

## Observability

Pass a logger to the MPP or x402 factory to emit structured events:

- `payment_required`
- `payment_settled`
- `payment_failed`
- `request_completed`

```ts
import { consoleJsonLogger } from "@zeroclickai/paywrap/logger";
import { createPaywrapMpp } from "@zeroclickai/paywrap/mpp";

const mpp = createPaywrapMpp({
	walletPrivateKey: env.WALLET_PRIVATE_KEY,
	publicBaseUrl: env.PUBLIC_BASE_URL,
	mppSecretKey: env.MPP_SECRET_KEY,
	tempoRpcUrl: env.TEMPO_RPC_URL,
	logger: consoleJsonLogger,
});
```

The logger hook is sink-agnostic. `consoleJsonLogger` works anywhere stdout is collected, including Cloudflare Workers tail logs, Render logs, `journalctl`, and hosted log drains. Custom loggers can forward to Datadog, Workers Analytics Engine, or another internal sink.

Logger failures are isolated from paid calls. Adapters dispatch through `safeLog`, which swallows synchronous throws and async rejections from the logging sink.

## Privacy Invariants

- Raw payment headers are never emitted by the kit.
- Signatures and private keys are never logged.
- Credential fingerprints are shortened before they appear in structured events.
- Payer addresses are public on-chain identifiers and are safe to include in settlement logs.

## Production Checklist

Before registering or advertising a service:

- Serve `/openapi.json` with `x-payment-info` and `402` responses on paid operations.
- Make paid routes return real `402` challenge headers when called without payment.
- Add `/healthz`.
- Complete the [provider readiness checklist](./list-on-zero.md#provider-readiness-checklist), then register the public base URL with `POST https://api.zero.xyz/v1/register`.
- Use stable `sku` and `pricingVersion` values.
- Validate request bodies in `preCheck` for charge-based routes.
- Use durable state: Redis for Node session services, Workers KV for charge intent and low-concurrency Worker services.
- Pass a logger such as `consoleJsonLogger` or a composed sink.
- Never log raw `Payment ...` headers.
- Emit `paywrap_refund_owed` for post-settlement failures that should not bill the buyer.
- Set real `PUBLIC_BASE_URL`, `WALLET_PRIVATE_KEY`, `MPP_SECRET_KEY`, and RPC env vars.
- Smoke test the 402 flow: no credential returns `402`, signed credential returns the paid result.
