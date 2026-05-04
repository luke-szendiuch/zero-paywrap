# List Your Service On Zero

Once your paid service is deployed, register its public base URL with Zero so agents can discover and call it.

Zero registration is intentionally small: you submit the base URL, and Zero crawls the service discovery documents from that URL. Your service must expose OpenAPI payment metadata and real `402` payment challenges before you register it.

## Required Service URLs

Your deployed service should serve:

- `GET /openapi.json`
- at least one paid route that returns `402 Payment Required` without a payment credential
- `GET /healthz` for operators

The most important file is `/openapi.json`. Zero's registrar uses it to enumerate callable capabilities and read pricing. Each paid operation should include:

- a normal OpenAPI path, method, request schema, and response schema
- `x-payment-info` with payment method, currency, amount, SKU, and pricing version
- a `402` response

The live route is still the source of truth for the exact payment challenge. OpenAPI tells Zero what exists and what it costs; the route's `402` headers tell the buyer exactly what to sign.

## OpenAPI Example

You can generate the OpenAPI document from the same manifest used by your route gates:

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
			description: "Render Mermaid diagram text to SVG bytes.",
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
			{ title: "Diagram Render Service", version: "1.0.0" },
			{ serverUrl: c.env.PUBLIC_BASE_URL },
		),
	),
);
```

`buildPaywrapJson` from the same subpath exists for internal Paywrap-specific tooling; it is not part of the public discovery contract and you do not need to serve it for registration.

The paid operation in `/openapi.json` should contain a payment extension like this:

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

Use stable `sku` values and increment `pricingVersion` when a priced unit changes.

## Register With Zero

Register the public base URL after deployment:

```sh
curl -X POST "https://zero.xyz/v1/register" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://your-service.example.com",
    "protocol": "mpp"
  }'
```

For x402 services, use:

```json
{
	"url": "https://your-service.example.com",
	"protocol": "x402"
}
```

`url` should be the service origin, not the OpenAPI URL and not a specific paid route. Zero will derive discovery URLs such as `https://your-service.example.com/openapi.json`.

## Preflight Before Registering

Before registering, treat the service like a public paid product, not just a reachable URL. Zero can index a capability as soon as discovery works, so make sure the service is ready for agents to spend money against it.

Run these checks from outside your deployment environment:

```sh
curl -fsS "https://your-service.example.com/healthz"
curl -fsS "https://your-service.example.com/openapi.json"
curl -i -X POST "https://your-service.example.com/v1/render"
```

The unauthenticated paid route should return:

- status `402 Payment Required`
- a payment challenge header, usually `WWW-Authenticate: Payment ...`
- a JSON body that explains payment is required

If `/openapi.json` is missing, stale, or missing `x-payment-info`, registration can succeed at the HTTP layer but produce no indexed capabilities.

## Provider Readiness Checklist

Complete these checks before calling `/v1/register`.

### Product And Pricing

- The service name, OpenAPI title, and operation descriptions are clear to someone who has never seen your code.
- Each paid operation has a stable `sku` that describes the priced unit, not an implementation detail.
- `pricingVersion` is set and will be incremented whenever the price, unit, or billing semantics change.
- Prices are intentional, visible in OpenAPI, and match the runtime gate amounts exactly.
- Each paid route documents what counts as a successful paid result, including binary response types such as SVG, PNG, PDF, or audio.
- Error responses are described well enough for an agent to recover or report a useful failure.

### Discovery Contract

- `PUBLIC_BASE_URL` is the deployed HTTPS origin that buyers should call.
- `/openapi.json` is public, cache-safe, and generated from the same route/pricing source of truth used by the gates.
- Every paid operation includes request schemas, response schemas, `x-payment-info`, and a `402` response.
- The OpenAPI `servers` value points at the deployed origin, not localhost or a preview URL.
- OpenAPI plus the live `402` headers are the entire public discovery contract; `/.well-known/paywrap.json` is internal/legacy and not required for registration.

### Payment Behavior

- Calling each paid route without credentials returns `402 Payment Required`.
- The `402` response includes a live payment challenge header, usually `WWW-Authenticate: Payment ...`.
- The payment challenge amount, scope, SKU, and pricing version match OpenAPI.
- Charge-based routes reject malformed or unsupported requests in `preCheck` before settlement.
- Follow-up proof routes validate the payer/owner relationship and use a separate proof scope.
- Metered routes settle the actual amount and return a receipt for the amount charged.
- Session routes use durable state when running more than one replica.

### Operations And Safety

- `/healthz` checks the dependencies required to serve paid calls, including upstream APIs, storage, and RPC access.
- Logs include structured `payment_required`, `payment_settled`, `payment_failed`, and `request_completed` events.
- Logs never include raw `Payment ...` headers, private keys, or upstream secrets.
- Post-settlement failures emit a `paywrap_refund_owed` event with payer, SKU, amount, reason, and a charge hash or credential fingerprint.
- The seller wallet, RPC URL, upstream credentials, and storage credentials are production values, not local defaults.
- Session-intent seller wallets are prefunded enough to open and close channels.
- The provider has a rollback plan if a route is registered with the wrong price, broken schema, or bad upstream behavior.

### Smoke Tests

- `curl /healthz` passes from outside the deployment environment.
- `curl /openapi.json` returns the expected public schema.
- An unauthenticated call to each paid route returns `402`.
- A signed paid call succeeds and returns the documented response shape.
- Bad input returns a non-paid validation error for charge-based routes.
- Deployment logs show the expected settlement and request completion events.

## Common Registration Problems

| Symptom | Likely Cause | Fix |
|---|---|---|
| Zero finds no capabilities | `/openapi.json` is missing or has no payment metadata | Serve OpenAPI with `x-payment-info` on paid operations. |
| Capability price is unknown | OpenAPI route lacks `x-payment-info.amount` or uses a non-standard extension | Generate OpenAPI with `buildOpenApiSpec` or mirror its shape. |
| Paid route appears but calls fail | Route does not return a live `402` payment challenge | Hit the route without credentials and inspect the `WWW-Authenticate` header. |
| Index points at localhost | `PUBLIC_BASE_URL` was not set to the deployed origin | Set `PUBLIC_BASE_URL` to the public URL and redeploy before registering. |
| Service works locally but not in Zero | Public deployment cannot reach required RPC, KV, Redis, or upstream env vars | Check `/healthz` and deployment logs. |

## Registration Checklist

After the provider readiness checklist passes:

- Register the base URL with `POST https://zero.xyz/v1/register`.
- Confirm Zero indexed the expected capabilities, prices, and methods.
- If discovery changes later, redeploy first, re-run the smoke tests, then register again.
