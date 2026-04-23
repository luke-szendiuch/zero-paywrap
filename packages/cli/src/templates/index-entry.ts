import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Entry point: boot env → mppx → Fastify → routes. The template hard-codes
 * the mount paths but leaves per-resource logic to the route files.
 */
export const indexEntryTemplate = (config: ScaffoldConfig): string => {
	const usePg = config.storage === "postgres-drizzle";
	const useRedis = config.queue === "bullmq-redis";

	const imports: string[] = [
		`import "dotenv/config";`,
		`import { createPaywrapMpp, memoryStore${useRedis ? ", redisStore" : ""} } from "@zerorun/paywrap/mpp";`,
	];
	if (useRedis) imports.push(`import IORedis from "ioredis";`);
	imports.push(`import { buildApp } from "./app/build-app.js";`);
	imports.push(`import { parseEnv } from "./core/env.js";`);
	if (usePg) imports.push(`import { makeDb, makePgPool } from "./db/client.js";`);
	imports.push(`import { healthRoutes } from "./routes/health.js";`);
	imports.push(`import { thingRoutes } from "./routes/things.js";`);
	imports.push(`import { wellKnownRoutes } from "./routes/wellknown.js";`);
	if (useRedis) {
		imports.push(`import { makeQueues } from "./worker/queue.js";`);
		imports.push(`import { type WorkerRuntime, startWorkerRuntime } from "./worker/start.js";`);
	}

	// Body
	const setup: string[] = [];
	setup.push("\tconst env = parseEnv(process.env);");
	if (usePg) {
		setup.push("\tconst pool = makePgPool(env.DATABASE_URL);");
		setup.push("\tconst db = makeDb(pool);");
	}
	if (useRedis) {
		setup.push("\t// Dedicated logical DB keeps mppx channel keys away from BullMQ queues.");
		setup.push(
			"\tconst mppxRedis = new IORedis(env.REDIS_URL, { db: 9, maxRetriesPerRequest: null });",
		);
		setup.push("\tconst store = redisStore(mppxRedis);");
	} else {
		setup.push("\tconst store = memoryStore();");
	}
	setup.push("\tconst mpp = createPaywrapMpp({");
	setup.push("\t\twalletPrivateKey: env.WALLET_PRIVATE_KEY as `0x${string}`,");
	setup.push("\t\tpublicBaseUrl: env.PUBLIC_BASE_URL,");
	setup.push("\t\tmppSecretKey: env.MPP_SECRET_KEY,");
	setup.push("\t\ttempoRpcUrl: env.TEMPO_RPC_URL,");
	setup.push("\t\tstore,");
	setup.push("\t});");
	if (useRedis) setup.push("\tconst queues = makeQueues(env.REDIS_URL);");

	const ctxLines: string[] = [
		"\t\tenv,",
		"\t\twalletAddress: mpp.account.address,",
		"\t\tmppx: mpp.mppx,",
		"\t\tchannelStore: mpp.channelStore,",
		"\t\tmppxClient: mpp.client,",
		"\t\tmppxAccount: mpp.account,",
	];
	if (usePg) ctxLines.push("\t\tdb,");
	if (useRedis) {
		ctxLines.push("\t\tqueues,");
		ctxLines.push("\t\tmppxRedis,");
	}

	const mount: string[] = [
		`\tawait app.register(healthRoutes, { prefix: "/healthz" });`,
		`\tawait app.register(wellKnownRoutes, { prefix: "/.well-known" });`,
		`\tawait app.register(thingRoutes, { prefix: "/v1/things" });`,
	];

	const shutdown: string[] = [];
	shutdown.push("\tlet shuttingDown = false;");
	shutdown.push("\tconst shutdown = async (signal: string) => {");
	shutdown.push("\t\tif (shuttingDown) return;");
	shutdown.push("\t\tshuttingDown = true;");
	shutdown.push(`\t\tapp.log.info({ signal }, "shutdown_start");`);
	shutdown.push("\t\ttry {");
	shutdown.push("\t\t\tawait app.close();");
	if (useRedis) {
		shutdown.push("\t\t\tif (worker) await worker.close();");
		shutdown.push("\t\t\tawait queues.things.close();");
		shutdown.push("\t\t\tmppxRedis.disconnect();");
	}
	if (usePg) shutdown.push("\t\t\tawait pool.end();");
	shutdown.push("\t\t\tprocess.exit(0);");
	shutdown.push("\t\t} catch (err) {");
	shutdown.push(`\t\t\tapp.log.error({ err }, "shutdown_failed");`);
	shutdown.push("\t\t\tprocess.exit(1);");
	shutdown.push("\t\t}");
	shutdown.push("\t};");
	shutdown.push(`\tprocess.on("SIGTERM", () => shutdown("SIGTERM"));`);
	shutdown.push(`\tprocess.on("SIGINT", () => shutdown("SIGINT"));`);

	const workerBlock = useRedis
		? `\tlet worker: WorkerRuntime | null = null;\n\tif (env.RUN_WORKER) {\n\t\tworker = startWorkerRuntime(env, mpp);\n\t\tapp.log.info("worker_running_inline");\n\t}\n`
		: "";

	return `${imports.join("\n")}

const main = async () => {
${setup.join("\n")}

\tconst app = await buildApp({
${ctxLines.join("\n")}
\t});

${mount.join("\n")}

\tawait app.listen({ port: env.PORT, host: "0.0.0.0" });
\tapp.log.info({ port: env.PORT, wallet: mpp.account.address }, "http_listening");

${workerBlock}
${shutdown.join("\n")}
};

main().catch((e) => {
\tconsole.error(e);
\tprocess.exit(1);
});
`;
};
