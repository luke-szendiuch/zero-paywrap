import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Generate `src/core/env.ts`. The zod schema mirrors the envs documented in
 * `.env.example` — keep them in sync or runtime will reject something the
 * user correctly set.
 */
export const envSchemaTemplate = (config: ScaffoldConfig): string => {
	const fields: string[] = [
		`\tNODE_ENV: z.enum(["development", "test", "production"]).default("development"),`,
		"\tPORT: z.coerce.number().default(3000),",
		`\tLOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),`,
		"\tPUBLIC_BASE_URL: z.string().url(),",
		"\tWALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),",
		"\tMPP_SECRET_KEY: z.string().min(32),",
		"\tTEMPO_RPC_URL: z.string().url(),",
		`\tZERO_API_URL: z.string().url().default("https://api.zero.run"),`,
		`\tSKU_PRICE_USDC_MICRO: z.coerce.bigint().default(${
			Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000
		}n),`,
		`\tSKU_DURATION_SECONDS: z.coerce.number().default(${config.durationSeconds}),`,
	];
	if (config.intent === "session" && config.storage === "postgres-drizzle") {
		fields.push("\tDATABASE_URL: z.string().url(),");
	}
	if (config.queue === "bullmq-redis") {
		fields.push("\tREDIS_URL: z.string().url(),");
		fields.push(
			`\tRUN_WORKER: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),`,
		);
	}

	return `import { z } from "zod";

const EnvSchema = z.object({
${fields.join("\n")}
});

export type Env = z.infer<typeof EnvSchema>;

export const parseEnv = (raw: NodeJS.ProcessEnv | Record<string, unknown>): Env => {
\tconst parsed = EnvSchema.safeParse(raw);
\tif (!parsed.success) {
\t\tconst issues = parsed.error.issues
\t\t\t.map((i) => \`  - \${i.path.join(".") || "(root)"}: \${i.message}\`)
\t\t\t.join("\\n");
\t\tthrow new Error(
\t\t\t\`Invalid env:\\n\${issues}\\n\\nSee .env.example — generate missing keys with \\\`pnpm setup generate-wallet\\\` or \\\`pnpm setup generate-secrets\\\`.\`,
\t\t);
\t}
\treturn parsed.data;
};
`;
};
