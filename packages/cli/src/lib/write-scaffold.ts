import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appContextTemplate } from "../templates/app-context.js";
import { biomeTemplate } from "../templates/biome.js";
import { buildAppTemplate } from "../templates/build-app.js";
import {
	dbClientTemplate,
	dbMigrateTemplate,
	drizzleConfigTemplate,
	thingModelTemplate,
} from "../templates/db.js";
import { dockerfileTemplate } from "../templates/dockerfile.js";
import { envExampleTemplate } from "../templates/env-example.js";
import { envSchemaTemplate } from "../templates/env-schema.js";
import { gitignoreTemplate } from "../templates/gitignore.js";
import {
	devVarsExampleTemplate,
	honoWorkerEntryTemplate,
	honoWorkersGitignoreTemplate,
	honoWorkersPackageJsonTemplate,
	honoWorkersReadmeTemplate,
	honoWorkersTsconfigTemplate,
	wranglerTomlTemplate,
} from "../templates/hono-workers.js";
import { indexEntryTemplate } from "../templates/index-entry.js";
import { packageJsonTemplate } from "../templates/package-json.js";
import { readmeTemplate } from "../templates/readme.js";
import { reaperJobTemplate } from "../templates/reaper-job.js";
import { routesHealthTemplate } from "../templates/routes-health.js";
import { routesThingsTemplate } from "../templates/routes-things.js";
import { routesWellKnownTemplate } from "../templates/routes-wellknown.js";
import { setupScriptTemplate } from "../templates/setup-script.js";
import { thingClientTemplate } from "../templates/thing-client.js";
import { tsconfigTemplate } from "../templates/tsconfig.js";
import { vitestConfigTemplate } from "../templates/vitest-config.js";
import {
	sessionSettleJobTemplate,
	workerIndexTemplate,
	workerQueueTemplate,
	workerStartTemplate,
} from "../templates/worker.js";
import type { ScaffoldConfig } from "./scaffold-config.js";

/** On-disk layout built in-memory first so tests can snapshot it. */
export type ScaffoldFileMap = Record<string, string>;

export const buildScaffoldFileMap = (config: ScaffoldConfig): ScaffoldFileMap => {
	if (config.framework === "hono-workers") return buildHonoWorkersFileMap(config);
	const files: ScaffoldFileMap = {};
	files["package.json"] = packageJsonTemplate(config);
	files["tsconfig.json"] = tsconfigTemplate();
	files["biome.json"] = biomeTemplate();
	files["vitest.config.ts"] = vitestConfigTemplate();
	files[".env.example"] = envExampleTemplate(config);
	files[".gitignore"] = gitignoreTemplate();
	files.Dockerfile = dockerfileTemplate();
	files["README.md"] = readmeTemplate(config);

	files["src/index.ts"] = indexEntryTemplate(config);
	files["src/app/app-context.ts"] = appContextTemplate(config);
	files["src/app/build-app.ts"] = buildAppTemplate();
	files["src/core/env.ts"] = envSchemaTemplate(config);
	files["src/routes/things.ts"] = routesThingsTemplate(config);
	files["src/routes/health.ts"] = routesHealthTemplate(config);
	files["src/routes/wellknown.ts"] = routesWellKnownTemplate(config);
	files["src/setup/index.ts"] = setupScriptTemplate();

	// Charge intent is stateless — upstream provider is source of truth.
	// Skip drizzle/db/models; emit a typed client stub instead.
	if (config.intent === "charge") {
		files["src/services/thing-client.ts"] = thingClientTemplate(config);
	} else if (config.storage === "postgres-drizzle") {
		files["src/db/client.ts"] = dbClientTemplate();
		files["src/db/migrate.ts"] = dbMigrateTemplate();
		files["src/models/thing.ts"] = thingModelTemplate(config);
		files["drizzle.config.ts"] = drizzleConfigTemplate();
	}

	if (config.queue === "bullmq-redis") {
		files["src/worker/queue.ts"] = workerQueueTemplate();
		files["src/worker/index.ts"] = workerIndexTemplate(config);
		files["src/worker/start.ts"] = workerStartTemplate(config);
		if (config.intent === "session") {
			files["src/worker/jobs/session-settle-job.ts"] = sessionSettleJobTemplate();
		} else {
			// Charge intent: only worker job is a provider-specific reaper stub.
			files["src/worker/jobs/reaper-job.ts"] = reaperJobTemplate();
		}
	}

	// Pre-seed .env with the generated wallet so the user can run immediately.
	// Address-only mode never persists the private key — caller is responsible
	// for printing it to stdout once if the user wants to keep it.
	if (config.wallet) {
		const envLines: string[] = [];
		if (config.walletMode === "private-key") {
			envLines.push(`WALLET_PRIVATE_KEY=${config.wallet.privateKey}`);
		}
		envLines.push(`WALLET_ADDRESS=${config.wallet.address}`);
		files[".env"] = `${envLines.join("\n")}\n`;
	}

	return files;
};

/**
 * Cloudflare Workers + Hono scaffold. Charge intent only for v1 — session
 * intent on Workers is feasible (kit ships `workersKvStore`) but the KV
 * store is not linearizable and that warning belongs in a deliberate
 * follow-up rather than buried inside a scaffold prompt.
 */
const buildHonoWorkersFileMap = (config: ScaffoldConfig): ScaffoldFileMap => {
	const files: ScaffoldFileMap = {};
	files["package.json"] = honoWorkersPackageJsonTemplate(config);
	files["tsconfig.json"] = honoWorkersTsconfigTemplate();
	files["biome.json"] = biomeTemplate();
	files["wrangler.toml"] = wranglerTomlTemplate(config);
	files[".dev.vars.example"] = devVarsExampleTemplate(config);
	files[".gitignore"] = honoWorkersGitignoreTemplate();
	files["README.md"] = honoWorkersReadmeTemplate(config);
	files["src/worker.ts"] = honoWorkerEntryTemplate(config);

	// Pre-seed .dev.vars for `wrangler dev`. Mirrors the .env behavior in
	// the fastify scaffold — address-only never persists the private key.
	if (config.wallet) {
		const lines: string[] = [];
		if (config.walletMode === "private-key") {
			lines.push(`WALLET_PRIVATE_KEY=${config.wallet.privateKey}`);
		}
		files[".dev.vars"] = `${lines.join("\n")}\n`;
	}
	return files;
};

/**
 * Write every file in `map` under `targetDir`. Creates intermediate dirs.
 * Does NOT wipe existing content — caller is expected to have chosen empty.
 */
export const writeScaffoldFiles = async (
	targetDir: string,
	map: ScaffoldFileMap,
): Promise<void> => {
	await mkdir(targetDir, { recursive: true });
	for (const [relPath, content] of Object.entries(map)) {
		const abs = join(targetDir, relPath);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
};
