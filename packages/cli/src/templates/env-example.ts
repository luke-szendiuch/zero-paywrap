import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Produce `.env.example`. The generated file documents every variable the
 * runtime env schema (`src/core/env.ts`) reads — if you add one there, add
 * the matching line here.
 */
export const envExampleTemplate = (config: ScaffoldConfig): string => {
	const lines: string[] = [];
	lines.push("# ──────────────────────────────────────────────────────────────────────");
	lines.push(`# ${config.serviceName} — environment template`);
	lines.push("# ──────────────────────────────────────────────────────────────────────");
	if (config.hosting === "render") {
		lines.push("#");
		lines.push("# Render gotchas:");
		lines.push("#   - DATABASE_URL: use the INTERNAL URL when service + DB are in the same");
		lines.push("#     region. External URLs require ?sslmode=require.");
		lines.push("#   - REDIS_URL: use rediss:// (TLS) for Render Managed Redis.");
		lines.push("#   - PUBLIC_BASE_URL: Render supplies RENDER_EXTERNAL_URL automatically; map it");
		lines.push("#     here in render.yaml (no trailing slash).");
	} else if (config.hosting === "fly") {
		lines.push("# Fly gotchas: DATABASE_URL on Fly Postgres uses the .flycast internal host.");
	} else if (config.hosting === "railway") {
		lines.push("# Railway gotchas: use the internal REDIS_URL / DATABASE_URL from service refs.");
	}
	lines.push("");

	lines.push("NODE_ENV=development");
	lines.push("PORT=3000");
	lines.push("LOG_LEVEL=info");
	lines.push("");
	lines.push("# Public URL where this service is reachable. Must have a hostname.");
	lines.push("PUBLIC_BASE_URL=http://localhost:3000");
	lines.push("");
	lines.push("# Wallet that receives payment. Generate with: paywrap generate-wallet");
	lines.push(
		"WALLET_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000",
	);
	lines.push("");
	lines.push("# HMAC key that binds mppx challenge ids to this server (min 32 bytes of entropy).");
	lines.push(
		"# Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
	);
	lines.push("MPP_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000000");
	lines.push("");
	lines.push("# Tempo mainnet RPC. Free public endpoint: https://rpc.tempo.xyz");
	lines.push("TEMPO_RPC_URL=https://rpc.tempo.xyz");
	lines.push("");
	lines.push("# Where Zero's catalog lives. Mainnet: https://api.zero.run");
	lines.push("ZERO_API_URL=https://api.zero.run");
	lines.push("");
	lines.push("# Pricing");
	lines.push(
		`SKU_PRICE_USDC_MICRO=${(Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000).toString()}`,
	);
	lines.push(`SKU_DURATION_SECONDS=${config.durationSeconds}`);
	lines.push("");

	if (config.intent === "session" && config.storage === "postgres-drizzle") {
		lines.push("# Postgres");
		lines.push(`DATABASE_URL=postgres://localhost:5432/${config.serviceName.replace(/-/g, "_")}`);
		lines.push("");
	}
	if (config.queue === "bullmq-redis") {
		lines.push("# Redis (queue + mppx channel store share the URL, different logical DBs)");
		lines.push("REDIS_URL=redis://localhost:6379");
		lines.push("# Run the BullMQ worker + crons inline with the HTTP server.");
		lines.push("# Set to false in a scaled deploy and run `pnpm dev:worker` on one replica.");
		lines.push("RUN_WORKER=true");
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
};
