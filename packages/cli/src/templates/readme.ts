import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const readmeTemplate = (config: ScaffoldConfig): string => {
	const priceUsdc = config.priceUsdc;
	// Collect step bodies unnumbered, then number sequentially so skipped
	// optional steps don't leave gaps (`1, 2, 5, 6`).
	const stepBodies: string[] = [];
	stepBodies.push("Copy `.env.example` to `.env` and fill in required values.");
	if (!config.wallet) {
		stepBodies.push(
			"Generate a wallet: `npx @zeroclickai/paywrap-cli generate-wallet`. Paste into `.env`.",
		);
	} else {
		stepBodies.push(
			`Wallet already generated: \`${config.wallet.address}\` (private key is in your \`.env\`).`,
		);
	}
	if (config.intent === "session") {
		stepBodies.push(
			"Prefund the wallet with ~0.05 USDC on Tempo: `npx @zeroclickai/paywrap-cli prefund <address>`. Session intent needs this because the seller pays gas on channel close.",
		);
	}
	if (config.storage === "postgres-drizzle") {
		stepBodies.push("Generate and run migrations: `pnpm db:generate && pnpm db:migrate`.");
	}
	stepBodies.push("Start: `pnpm dev`.");
	stepBodies.push(
		"Publish to Zero once public: `npx @zeroclickai/paywrap-cli register` (needs `ZERO_API_URL`, `PUBLIC_BASE_URL`, `WALLET_PRIVATE_KEY`).",
	);
	const steps = stepBodies.map((body, i) => `${i + 1}. ${body}`);

	// Example invocation against the scaffolded endpoint. For both intents
	// the buyer first hits the endpoint (402) then retries with a credential
	// minted from that challenge — `zero fetch` handles both legs.
	const exampleMethod = config.intent === "session" ? "POST" : "POST";
	const exampleCurl = `# First call returns 402 with a Payment challenge in the www-authenticate header.
curl -X ${exampleMethod} "$PUBLIC_BASE_URL/v1/things" -i

# The \`zero\` CLI (buyer-side) handles the challenge + retry in one go:
zero fetch ${exampleMethod} "$PUBLIC_BASE_URL/v1/things"`;

	return `# ${config.serviceName}

Paid API service scaffolded with \`@zeroclickai/paywrap-cli\`.

- **Intent:** \`${config.intent}\`${config.intent === "session" ? " (one channel = many paid requests)" : " (one-shot payment)"}
- **Price:** ${priceUsdc} USDC per charge
- **Scope:** \`${config.scope}\`
- **Session duration:** ${config.durationSeconds} seconds
- **Framework:** ${config.framework}
- **Storage:** ${config.intent === "charge" ? "none (stateless — upstream is source of truth)" : config.storage}
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
${config.intent === "charge" ? "- `src/services/thing-client.ts` — typed client for your upstream provider (source of truth for resources)\n" : ""}${config.intent === "session" && config.storage === "postgres-drizzle" ? "- `src/models/thing.ts` — Drizzle schema\n- `src/db/` — client + migrator\n" : ""}${config.queue === "bullmq-redis" ? "- `src/worker/` — BullMQ worker + cron drivers\n" : ""}

## Ops commands

\`\`\`sh
npx @zeroclickai/paywrap-cli check $PUBLIC_BASE_URL    # health + well-known
npx @zeroclickai/paywrap-cli register                  # publish to Zero catalog
\`\`\`

## Where the kit ends and your service begins

The scaffold stops at the \`// TODO: implement\` markers. Business logic — your
actual resource, persistence, upstream API calls — lives in your service repo
and is never dragged into \`@zeroclickai/paywrap\`.
${
	config.intent === "charge"
		? `\nThis scaffold is **stateless** — your upstream provider (Netlify, R2,
whatever you're reselling) is the source of truth. No Postgres, no
voucher ledger. See \`docs/learnings.md\` in
\`zero-netlify-integration\` for the reference pattern.`
		: ""
}

## Calling the endpoint

\`\`\`sh
${exampleCurl}
\`\`\`
`;
};
