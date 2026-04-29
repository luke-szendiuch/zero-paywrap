# List Your Service On Zero

Once your paid service is deployed, register its public base URL with Zero so agents can discover and call it.

Zero registration is intentionally small: you submit the base URL, and Zero crawls the service discovery documents from that URL. Your service must expose OpenAPI payment metadata and real `402` payment challenges before you register it.

## Required Service URLs

Your deployed service should serve:

- `GET /openapi.json`
- at least one paid route that returns `402 Payment Required` without a payment credential
- optionally `GET /.well-known/paywrap.json` for Paywrap-aware tooling
- `GET /healthz` for operators

The most important file is `/openapi.json`. Zero's registrar uses it to enumerate callable capabilities and read pricing. Each paid operation should include:

- a normal OpenAPI path, method, request schema, and response schema
- `x-payment-info` with payment method, currency, amount, SKU, and pricing version
- a `402` response

The live route is still the source of truth for the exact payment challenge. OpenAPI tells Zero what exists and what it costs; the route's `402` headers tell the buyer exactly what to sign.

## OpenAPI Example

You can generate the OpenAPI document from the same manifest used by your route gates:

```ts
import { buildOpenApiSpec, buildPaywrapJson } from "@zeroclickai/paywrap/manifest";

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

// Optional, but useful for Paywrap-specific tooling.
app.get("/.well-known/paywrap.json", (c) => c.json(buildPaywrapJson(manifest)));
```

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

## Common Registration Problems

| Symptom | Likely Cause | Fix |
|---|---|---|
| Zero finds no capabilities | `/openapi.json` is missing or has no payment metadata | Serve OpenAPI with `x-payment-info` on paid operations. |
| Capability price is unknown | OpenAPI route lacks `x-payment-info.amount` or uses a non-standard extension | Generate OpenAPI with `buildOpenApiSpec` or mirror its shape. |
| Paid route appears but calls fail | Route does not return a live `402` payment challenge | Hit the route without credentials and inspect the `WWW-Authenticate` header. |
| Index points at localhost | `PUBLIC_BASE_URL` was not set to the deployed origin | Set `PUBLIC_BASE_URL` to the public URL and redeploy before registering. |
| Service works locally but not in Zero | Public deployment cannot reach required RPC, KV, Redis, or upstream env vars | Check `/healthz` and deployment logs. |

## Registration Checklist

- Public URL is deployed and reachable over HTTPS.
- `PUBLIC_BASE_URL` matches that public origin.
- `/openapi.json` includes every paid route.
- Paid operations include `x-payment-info` and a `402` response.
- Paid routes return live `402` challenge headers without credentials.
- `/.well-known/paywrap.json` is served if you want Paywrap-aware tooling.
- `/healthz` passes.
- You registered the base URL with `POST https://zero.xyz/v1/register`.
