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
import { indexEntryTemplate } from "../templates/index-entry.js";
import { packageJsonTemplate } from "../templates/package-json.js";
import { readmeTemplate } from "../templates/readme.js";
import { routesHealthTemplate } from "../templates/routes-health.js";
import { routesThingsTemplate } from "../templates/routes-things.js";
import { routesWellKnownTemplate } from "../templates/routes-wellknown.js";
import { setupScriptTemplate } from "../templates/setup-script.js";
import { tsconfigTemplate } from "../templates/tsconfig.js";
import { vitestConfigTemplate } from "../templates/vitest-config.js";
import {
	sessionSettleJobTemplate,
	workerIndexTemplate,
	workerQueueTemplate,
	workerStartTemplate,
} from "../templates/worker.js";
import type { ScaffoldConfig } from "./scaffold-config.js";

/**
 * Resolved on-disk layout — the record of every file the scaffold produces.
 * Built in-memory first so tests can snapshot it without hitting the
 * filesystem.
 */
export type ScaffoldFileMap = Record<string, string>;

export const buildScaffoldFileMap = (config: ScaffoldConfig): ScaffoldFileMap => {
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

	if (config.storage === "postgres-drizzle") {
		files["src/db/client.ts"] = dbClientTemplate();
		files["src/db/migrate.ts"] = dbMigrateTemplate();
		files["src/models/thing.ts"] = thingModelTemplate(config);
		files["drizzle.config.ts"] = drizzleConfigTemplate();
	}

	if (config.queue === "bullmq-redis") {
		files["src/worker/queue.ts"] = workerQueueTemplate();
		files["src/worker/index.ts"] = workerIndexTemplate();
		files["src/worker/start.ts"] = workerStartTemplate(config);
		if (config.intent === "session") {
			files["src/worker/jobs/session-settle-job.ts"] = sessionSettleJobTemplate();
		}
	}

	// .env pre-seeded with the generated wallet so the user can run immediately.
	if (config.wallet) {
		const envLines = [
			`WALLET_PRIVATE_KEY=${config.wallet.privateKey}`,
			`WALLET_ADDRESS=${config.wallet.address}`,
		];
		files[".env"] = `${envLines.join("\n")}\n`;
	}

	return files;
};

/**
 * Write every file in `map` under `targetDir`. Safe across parent-dir depth —
 * creates intermediate directories. Does NOT wipe existing content in the
 * target; caller is expected to have chosen an empty dir.
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
