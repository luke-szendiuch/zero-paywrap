import { stringifyTabs } from "../lib/json-tabs.js";
import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Templates specific to the `hono-workers` framework — Cloudflare Workers
 * + Hono + paywrap. The shape diverges from the fastify scaffold enough
 * (no node entry, wrangler.toml, env via `c.env`) that it earns its own
 * file rather than threading branches through every fastify template.
 *
 * v1 is charge-intent only. Session-on-Workers is feasible (Workers KV is
 * supported by the kit) but isn't wired here yet — the KV adapter is not
 * linearizable and that needs a louder warning surface than a scaffold.
 */

export const honoWorkersTsconfigTemplate = (): string =>
	`${stringifyTabs({
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			lib: ["ES2023"],
			strict: true,
			noUncheckedIndexedAccess: true,
			esModuleInterop: true,
			skipLibCheck: true,
			forceConsistentCasingInFileNames: true,
			resolveJsonModule: true,
			isolatedModules: true,
			noEmit: true,
			types: ["@cloudflare/workers-types"],
		},
		include: ["src/**/*", "__tests__/**/*"],
		exclude: ["dist", "node_modules"],
	})}\n`;

export const wranglerTomlTemplate = (config: ScaffoldConfig): string => {
	const safeName = config.serviceName.replace(/[^a-z0-9-]/g, "-");
	return `name = "${safeName}"
main = "src/worker.ts"
compatibility_date = "2024-12-01"

# Required because mppx pulls in \`node:util\` transitively. Without this
# flag the worker fails to boot. See packages/adapters/hono/README.md.
compatibility_flags = ["nodejs_compat"]

[vars]
PUBLIC_BASE_URL = "https://${safeName}.example.workers.dev"
TEMPO_RPC_URL = "https://rpc.tempo.xyz"
ZERO_API_URL = "https://api.zero.xyz"
${config.walletMode === "address-only" ? `WALLET_ADDRESS = "0x0000000000000000000000000000000000000000"` : "# WALLET_PRIVATE_KEY: set with `wrangler secret put WALLET_PRIVATE_KEY`"}

# Set MPP_SECRET_KEY${config.walletMode === "private-key" ? " and WALLET_PRIVATE_KEY" : ""} via:
#   wrangler secret put MPP_SECRET_KEY
${config.walletMode === "private-key" ? "#   wrangler secret put WALLET_PRIVATE_KEY\n" : ""}`;
};

export const devVarsExampleTemplate = (config: ScaffoldConfig): string => {
	const lines = ["# Local-only secrets for `wrangler dev`. Never commit `.dev.vars`."];
	lines.push("MPP_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000000");
	if (config.walletMode === "private-key") {
		lines.push(
			"WALLET_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000",
		);
	}
	return `${lines.join("\n")}\n`;
};

export const honoWorkerEntryTemplate = (config: ScaffoldConfig): string => {
	const addressOnly = config.walletMode === "address-only";
	const priceMicro = Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000;
	const envFields: string[] = [
		"\tPUBLIC_BASE_URL: string;",
		"\tTEMPO_RPC_URL: string;",
		"\tZERO_API_URL: string;",
		"\tMPP_SECRET_KEY: string;",
	];
	if (addressOnly) envFields.push("\tWALLET_ADDRESS: string;");
	else envFields.push("\tWALLET_PRIVATE_KEY: string;");

	const mppCall = addressOnly
		? "\t\twalletAddress: env.WALLET_ADDRESS as `0x${string}`,"
		: "\t\twalletPrivateKey: env.WALLET_PRIVATE_KEY as `0x${string}`,";

	const walletForManifest = addressOnly
		? "env.WALLET_ADDRESS as Address"
		: "privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`).address as Address";

	const accountImport = addressOnly ? "" : 'import { privateKeyToAccount } from "viem/accounts";\n';

	return `import { createHonoApp, mppGated } from "@zeroclickai/paywrap-adapter-hono";
import { buildOpenApiSpec, buildPaywrapJson } from "@zeroclickai/paywrap/manifest";
import { createPaywrapMpp, memoryStore } from "@zeroclickai/paywrap/mpp";
import type { Address } from "viem";
${accountImport}
/**
 * Worker environment. Vars come from \`wrangler.toml\`; secrets from
 * \`wrangler secret put\` (see README).
 */
export type Env = {
${envFields.join("\n")}
};

const SCOPE = "${config.scope}" as const;
/** Price in micro-USDC (USDC = 6 decimals). */
const PRICE_MICRO = ${priceMicro}n;

/** Build the mpp instance from Worker env bindings. */
export const mppFromEnv = (env: Env): ReturnType<typeof createPaywrapMpp> =>
	createPaywrapMpp({
${mppCall}
		mppSecretKey: env.MPP_SECRET_KEY,
		publicBaseUrl: env.PUBLIC_BASE_URL,
		tempoRpcUrl: env.TEMPO_RPC_URL,
		// In-memory store: fine for charge intent (state is per-request and
		// settles atomically). Switch to \`workersKvStore(env.PAYWRAP_KV)\`
		// if you wire a KV namespace.
		store: memoryStore(),
	});

export type BuildAppOptions = {
	/** Tests can pre-build the mpp to install \`stubVerifyCredential\`. */
	mpp?: ReturnType<typeof createPaywrapMpp>;
};

export const buildApp = (options: BuildAppOptions = {}) => {
	const app = createHonoApp<{
		mppx: ReturnType<typeof createPaywrapMpp>["mppx"];
		mppxChannelStore: ReturnType<typeof createPaywrapMpp>["channelStore"];
	}>((c) => {
		const mpp = options.mpp ?? mppFromEnv(c.env as Env);
		return { mppx: mpp.mppx, mppxChannelStore: mpp.channelStore };
	});

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	// Service discovery — Zero's indexer probes \`/openapi.json\` to enumerate
	// paid endpoints. Drop this and your service won't be indexed.
	const buildManifest = (env: Env) =>
		buildPaywrapJson({
			wallet: ${walletForManifest},
			paidRoutes: [
				{
					method: "POST",
					path: "/v1/things",
					protocol: "mpp",
					sku: "${config.scope}",
					priceUsdcMicro: PRICE_MICRO.toString(),
					pricingVersion: 1,
					description: "TODO: describe what this paid endpoint does.",
				},
			],
			freeRoutes: [
				{ method: "GET", path: "/healthz", description: "Liveness probe." },
				{ method: "GET", path: "/openapi.json", description: "Service discovery." },
				{
					method: "GET",
					path: "/.well-known/paywrap.json",
					description: "Extended paywrap manifest.",
				},
			],
		});

	app.get("/openapi.json", (c) => {
		const env = c.env as Env;
		return c.json(
			buildOpenApiSpec(
				buildManifest(env),
				{ title: "${config.serviceName}", version: "0.0.1" },
				{ serverUrl: env.PUBLIC_BASE_URL },
			),
		);
	});

	app.get("/.well-known/paywrap.json", (c) => c.json(buildManifest(c.env as Env)));

	app.post(
		"/v1/things",
		mppGated({ scope: SCOPE, amount: PRICE_MICRO, intent: "charge" }),
		(c) => {
			// TODO: implement — \`c.var.payer\` is the verified buyer address.
			return c.json({ id: \`thing_\${Date.now()}\`, payer: c.var.payer });
		},
	);

	return app;
};

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
		buildApp().fetch(request, env, ctx),
};
`;
};

export const honoWorkersReadmeTemplate = (config: ScaffoldConfig): string => {
	const addressOnly = config.walletMode === "address-only";
	return `# ${config.serviceName}

Cloudflare Workers + Hono + \`@zeroclickai/paywrap\` charge-intent service.

## Setup

\`\`\`bash
pnpm install
${
	addressOnly
		? "# Edit wrangler.toml: set WALLET_ADDRESS to the wallet that should\n# receive payment. Address-only mode — no private key on the worker."
		: "wrangler secret put WALLET_PRIVATE_KEY"
}
wrangler secret put MPP_SECRET_KEY   # 32+ bytes of entropy
\`\`\`

For local dev, copy \`.dev.vars.example\` → \`.dev.vars\` and fill it in.

## Run

\`\`\`bash
pnpm dev      # wrangler dev
pnpm deploy   # wrangler deploy
\`\`\`

## Routes

- \`POST /v1/things\` — paid (${config.priceUsdc} USDC, scope \`${config.scope}\`)
- \`GET /healthz\` — liveness
- \`GET /openapi.json\` — service discovery (required for Zero indexer)
- \`GET /.well-known/paywrap.json\` — extended paywrap manifest

## Register with Zero

Once deployed and reachable, register so other agents can find you:

\`\`\`bash
curl -X POST https://api.zero.xyz/v1/register \\
  -H 'content-type: application/json' \\
  -d '{"url":"https://${config.serviceName}.example.workers.dev"}'
\`\`\`

## Gotchas

- \`compatibility_flags = ["nodejs_compat"]\` is required (mppx imports \`node:util\`).
${addressOnly ? "- Address-only mode: the buyer pays Tempo gas in USDC, so this worker holds no private key. Save the private key for `WALLET_ADDRESS` somewhere safe — you'll need it to move the received USDC out.\n" : ""}`;
};

export const honoWorkersPackageJsonTemplate = (config: ScaffoldConfig): string => {
	const safeName = config.serviceName;
	return `${stringifyTabs({
		name: safeName,
		version: "0.0.1",
		private: true,
		type: "module",
		scripts: {
			dev: "wrangler dev",
			deploy: "wrangler deploy",
			typecheck: "tsc --noEmit",
			lint: "biome check",
			"lint:fix": "biome check --write",
			test: "vitest run",
		},
		dependencies: {
			"@zeroclickai/paywrap": "^0.0.16",
			"@zeroclickai/paywrap-adapter-hono": "^0.0.14",
			hono: "^4.8.0",
			mppx: "^0.6.14",
			viem: "^2.21.55",
		},
		devDependencies: {
			"@biomejs/biome": "^1.9.4",
			"@cloudflare/workers-types": "^4.20241224.0",
			"@types/node": "^22.10.2",
			typescript: "^5.7.2",
			vitest: "^2.1.8",
			wrangler: "^3.99.0",
		},
	})}\n`;
};

export const honoWorkersGitignoreTemplate = (): string => `node_modules
dist
.wrangler
.dev.vars
.env
.env.local
*.log
`;
