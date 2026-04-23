import { stringifyTabs } from "../lib/json-tabs.js";
import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Produce the generated service's `package.json`. Deps are conditional on
 * the user's choices — keep every `if` branch narrow so the diff of enabled
 * vs. disabled features stays readable.
 */
export const packageJsonTemplate = (config: ScaffoldConfig): string => {
	const deps: Record<string, string> = {
		"@zerorun/paywrap": "^0.0.1",
		mppx: "^0.6.2",
		viem: "^2.21.55",
		zod: "^3.24.1",
	};
	if (config.framework === "fastify") {
		deps.fastify = "^5.2.0";
		deps["fastify-type-provider-zod"] = "^4.0.2";
		deps["@zerorun/paywrap-adapter-fastify"] = "^0.0.1";
	}
	// Charge intent is stateless — no DB. Only wire drizzle/pg for session.
	if (config.intent === "session" && config.storage === "postgres-drizzle") {
		deps["drizzle-orm"] = "^0.38.0";
		deps.pg = "^8.13.1";
	}
	if (config.queue === "bullmq-redis") {
		deps.bullmq = "^5.28.0";
		deps.ioredis = "^5.10.1";
	}
	deps.dotenv = "^16.4.0";

	const devDeps: Record<string, string> = {
		"@biomejs/biome": "^1.9.4",
		"@types/node": "^22.10.2",
		tsx: "^4.19.2",
		typescript: "^5.7.2",
		vitest: "^2.1.8",
	};
	if (config.intent === "session" && config.storage === "postgres-drizzle") {
		devDeps["@types/pg"] = "^8.11.10";
		devDeps["drizzle-kit"] = "^0.30.1";
	}

	const scripts: Record<string, string> = {
		dev: "tsx watch src/index.ts",
		build: "tsc",
		start: "node --import tsx src/index.ts",
		typecheck: "tsc --noEmit",
		lint: "biome check",
		"lint:fix": "biome check --write",
		test: "vitest run",
		setup: "tsx src/setup/index.ts",
	};
	if (config.intent === "session" && config.storage === "postgres-drizzle") {
		scripts["db:generate"] = "drizzle-kit generate";
		scripts["db:migrate"] = "tsx src/db/migrate.ts";
	}
	if (config.queue === "bullmq-redis") {
		scripts["dev:worker"] = "tsx watch src/worker/index.ts";
	}

	return `${stringifyTabs({
		name: config.serviceName,
		version: "0.0.1",
		private: true,
		type: "module",
		scripts,
		dependencies: sortKeys(deps),
		devDependencies: sortKeys(devDeps),
	})}\n`;
};

const sortKeys = <T extends Record<string, string>>(o: T): T => {
	const out = {} as T;
	for (const k of Object.keys(o).sort()) (out as Record<string, string>)[k] = o[k] as string;
	return out;
};
