import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const readmeTemplate = (config: ScaffoldConfig): string => {
	const priceUsdc = config.priceUsdc;
	const steps: string[] = [];
	steps.push("1. Copy `.env.example` to `.env` and fill in required values.");
	if (!config.wallet) {
		steps.push(
			"2. Generate a wallet: `npx @zerorun/paywrap-cli generate-wallet`. Paste into `.env`.",
		);
	} else {
		steps.push(
			`2. Wallet already generated: \`${config.wallet.address}\` (private key is in your \`.env\`).`,
		);
	}
	if (config.intent === "session") {
		steps.push(
			"3. Prefund the wallet with ~0.05 USDC on Tempo: `npx @zerorun/paywrap-cli prefund <address>`. Session intent needs this because the seller pays gas on channel close.",
		);
	}
	if (config.storage === "postgres-drizzle") {
		steps.push("4. Generate and run migrations: `pnpm db:generate && pnpm db:migrate`.");
	}
	steps.push("5. Start: `pnpm dev`.");
	steps.push(
		"6. Publish to Zero once public: `npx @zerorun/paywrap-cli register` (needs `ZERO_API_URL`, `PUBLIC_BASE_URL`, `WALLET_PRIVATE_KEY`).",
	);

	return `# ${config.serviceName}

Paid API service scaffolded with \`@zerorun/paywrap-cli\`.

- **Intent:** \`${config.intent}\`${config.intent === "session" ? " (one channel = many paid requests)" : " (one-shot payment)"}
- **Price:** ${priceUsdc} USDC per charge
- **Scope:** \`${config.scope}\`
- **Session duration:** ${config.durationSeconds} seconds
- **Framework:** ${config.framework}
- **Storage:** ${config.storage}
- **Queue:** ${config.queue}

## Quickstart

${steps.join("\n")}

## Anatomy

- \`src/index.ts\` — boot (env → mppx → Fastify → routes → optional worker)
- \`src/app/\` — Fastify builder + shared context
- \`src/routes/things.ts\` — your paid resource. Look for \`// TODO: implement\`.
- \`src/routes/health.ts\` — \`/healthz\` aggregated via kit
- \`src/routes/wellknown.ts\` — \`/.well-known/paywrap.json\`
- \`src/core/env.ts\` — zod env schema
${config.storage === "postgres-drizzle" ? "- `src/models/thing.ts` — Drizzle schema\n- `src/db/` — client + migrator\n" : ""}${config.queue === "bullmq-redis" ? "- `src/worker/` — BullMQ worker + cron drivers\n" : ""}

## Ops commands

\`\`\`sh
npx @zerorun/paywrap-cli check $PUBLIC_BASE_URL    # health + well-known
npx @zerorun/paywrap-cli register                  # publish to Zero catalog
\`\`\`

## Where the kit ends and your service begins

The scaffold stops at the \`// TODO: implement\` markers. Business logic — your
actual resource, persistence, upstream API calls — lives in your service repo
and is never dragged into \`@zerorun/paywrap\`.
`;
};
