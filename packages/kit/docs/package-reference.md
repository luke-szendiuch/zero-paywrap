# Package Reference

`@zeroclickai/paywrap` ships no root barrel. Import only the subpath you need so services keep a clear dependency graph and small bundles.

## Subpaths

| Subpath | Use it for |
|---|---|
| `@zeroclickai/paywrap/mpp` | MPP service setup, Tempo chain constants, state stores, credential verification, session close helpers. |
| `@zeroclickai/paywrap/mpp/metered` | Metered MPP settlement helpers for max-authorized, actual-usage billing flows. |
| `@zeroclickai/paywrap/x402` | Seller-side x402 resource server setup for Base / Base Sepolia USDC settlement. |
| `@zeroclickai/paywrap/auth` | Building payment challenges, extracting payer identity from verified credentials, and credential fingerprinting. |
| `@zeroclickai/paywrap/signing` | Buyer-side voucher and charge credential signing for agents, CLIs, and integration tests. |
| `@zeroclickai/paywrap/testing` | Test-only helpers for seeded channels and stubbed credential verification. |
| `@zeroclickai/paywrap/crypto` | AES-256-GCM helpers for encrypting upstream credentials stored by your service. |
| `@zeroclickai/paywrap/manifest` | Typed route manifests plus OpenAPI generation with `x-payment-info` and `402` responses. |
| `@zeroclickai/paywrap/health` | Combining subsystem probes into a `/healthz` response. |
| `@zeroclickai/paywrap/setup` | Wallet generation, MPP secret generation, and wallet prefunding helpers used by setup scripts. |
| `@zeroclickai/paywrap/proxy` | Charge-intent upstream proxy helpers that preserve JSON and binary responses correctly. |
| `@zeroclickai/paywrap/logger` | Structured payment logging types, stdout JSON logging, safe logger dispatch, and credential fingerprint helpers. |

## Companion Packages

- [`@zeroclickai/paywrap-adapter-fastify`](../../adapters/fastify/) adds Fastify route gates and challenge helpers.
- [`@zeroclickai/paywrap-adapter-hono`](../../adapters/hono/) adds Hono, Cloudflare Workers, and Bun route gates.
- [`@zeroclickai/paywrap-cli`](../../cli/) scaffolds a complete paid service and wraps wallet setup commands.

## OpenAPI Helpers

The `manifest` subpath is the easiest way to keep pricing metadata in one typed place:

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

const openapi = buildOpenApiSpec(
	manifest,
	{ title: "Render Service", version: "1.0.0" },
	{ serverUrl: "https://api.example.com" },
);

const paywrapJson = buildPaywrapJson(manifest);
```

OpenAPI is the public contract. `buildOpenApiSpec` emits `x-payment-info` and a `402` response for paid operations. `buildPaywrapJson` is useful for Paywrap-aware tooling, but external consumers should not need it to understand price or payment flow.

