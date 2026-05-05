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

The kit does **not** ship an automated refund executor — refunds happen out of band by an operator process (a script that reads logs and sends USDC, or a manual review queue). Paywrap's job is making them auditable: emit one structured event per post-settlement failure in a fixed shape, so a single grep across log streams produces the refund queue.

Use `logRefundOwed` from `@zeroclickai/paywrap/logger` to emit the event in the canonical shape with a typed reason bucket:

```ts
import { logRefundOwed } from "@zeroclickai/paywrap/logger";

logRefundOwed({
	payer: req.payer,
	sku: "image-gen:v2",
	amountUsdcMicro: "50000",
	reason: "upstream_5xx",
	details: { upstreamStatus: 503 },
	chargeHash, // tx hash or shortFingerprint(fingerprintCredential(authHeader))
	route: "POST /v1/generate",
});
```

`reason` is a typed `RefundReason` union — adding a new bucket is a contract change, so service-specific specifics belong in `details` instead. Standard buckets:

| Reason | Use when |
|---|---|
| `upstream_5xx` | Upstream returned 5xx after settlement. |
| `upstream_4xx_post_settlement` | Upstream returned 4xx for a request the service should have caught in `preCheck` but didn't. |
| `upstream_timeout` | Network/socket timeout to the upstream. |
| `upstream_rate_limit` | Upstream returned 429. |
| `worker_crash` | Handler threw / process died after settlement. |
| `post_settlement_validation` | Validation only possible after the paid side-effect began (e.g. content moderation on generated output). |
| `unknown` | Fallback when none of the above fit; explain in `details`. |

The helper writes a JSON line to `console.error` by default. Pass a `sink` argument to redirect (tests, custom transports). Sink errors are swallowed so a flaky log destination cannot break the hot path. The function returns the emitted event so callers can fan it out to additional sinks (audit DB, structured-events pipeline) without re-deriving fields.

**When to emit:** post-settlement failures you would not intentionally bill for — upstream `5xx`, upstream rate limits, network timeouts, worker crashes after settlement, validation that could only run after a paid side-effect began.

**When NOT to emit:** `preCheck` rejections (those happen before settlement, no money moved). For upstream/user 4xx — decide per product: if the buyer paid for validation/linting, the 4xx is the paid result; if the upstream rejected an input you should have caught in `preCheck`, log the refund.

Never log the raw `Payment ...` header. The helper enforces this — it has no field for the raw header. Pass `chargeHash` (a tx hash or `shortFingerprint(fingerprintCredential(authHeader))`) when your route already computes one for idempotency; operators use it to dedupe retry storms.

The wire format (`msg: "paywrap_refund_owed"`, `v: 1`, ISO-8601 timestamp) is a fixed grep contract across paywrap services. The discriminator is the grep key — operators run `grep paywrap_refund_owed` across log streams to build the refund queue.

### Sending the refund: `refundCharge`

When you've decided to refund (operator approval, scheduled job, in-handler policy), `refundCharge` from `@zeroclickai/paywrap/refund` sends the USDC tx:

```ts
import { refundCharge } from "@zeroclickai/paywrap/refund";

// In an operator script consuming a paywrap_refund_owed line:
const { txHash } = await refundCharge(mpp, {
	payer: owedEvent.payer,
	amountUsdcMicro: BigInt(owedEvent.amountUsdcMicro),
	note: `refund for ${owedEvent.reason}`,
	chargeHash: owedEvent.chargeHash,
	sku: owedEvent.sku,
});
```

**Requirements:**

- Keyed mode — the seller wallet must have a private key in the runtime. Charge-intent's just-settled USDC funds the refund; gas is paid in USDC via `feeToken: USDC` on `tempoChain`. Address-only services need to add a key (and accept the operational surface that comes with it) before they can use this helper.
- Caller-owned idempotency — the kit ships no refund ledger. Track sent refunds in your DB and only call `refundCharge` for ones you haven't already processed. The `chargeHash` field is the natural dedup key.
- Caller-owned policy — the kit does NOT auto-trigger refunds from the request path. Build an operator script, a scheduled job, or an opt-in in-handler call. The kit gives you the primitive; you decide when to fire it.

A `paywrap_refund_sent` JSON line is emitted to `console.error` on success. Pairing with `paywrap_refund_owed` makes reconciliation a single grep across log streams: every owed event should eventually have a matching sent event (or an explicit operator decision to deny).

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
