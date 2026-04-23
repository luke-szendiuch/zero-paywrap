import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const workerQueueTemplate = (): string => `import { Queue } from "bullmq";
import IORedis from "ioredis";

export type ThingJobData = { thingId: string };

export const makeConnection = (redisUrl: string) =>
\tnew IORedis(redisUrl, { maxRetriesPerRequest: null });

export const makeQueues = (redisUrl: string) => ({
\tthings: new Queue<ThingJobData>("things", { connection: makeConnection(redisUrl) }),
});

export type Queues = ReturnType<typeof makeQueues>;
`;

export const workerIndexTemplate = (): string => `import "dotenv/config";
import { createPaywrapMpp, redisStore } from "@zerorun/paywrap/mpp";
import IORedis from "ioredis";
import { parseEnv } from "../core/env.js";
import { startWorkerRuntime } from "./start.js";

const main = async () => {
\tconst env = parseEnv(process.env);
\tconst mppxRedis = new IORedis(env.REDIS_URL, { db: 9, maxRetriesPerRequest: null });
\tconst mpp = createPaywrapMpp({
\t\twalletPrivateKey: env.WALLET_PRIVATE_KEY as \`0x\${string}\`,
\t\tpublicBaseUrl: env.PUBLIC_BASE_URL,
\t\tmppSecretKey: env.MPP_SECRET_KEY,
\t\ttempoRpcUrl: env.TEMPO_RPC_URL,
\t\tstore: redisStore(mppxRedis),
\t});
\tconst runtime = startWorkerRuntime(env, mpp);
\tconst shutdown = async () => {
\t\tawait runtime.close();
\t\tmppxRedis.disconnect();
\t\tprocess.exit(0);
\t};
\tprocess.on("SIGTERM", shutdown);
\tprocess.on("SIGINT", shutdown);
};

main().catch((e) => {
\tconsole.error(e);
\tprocess.exit(1);
});
`;

export const workerStartTemplate = (config: ScaffoldConfig): string => {
	const isSession = config.intent === "session";
	const sessionCronBlock = isSession
		? `\tconst sessionSettle = makeSessionSettleJob(mpp);
\tconst sessionInterval = setInterval(
\t\t() => sessionSettle().catch(() => undefined),
\t\t60 * 60 * 1000,
\t);
\tsessionInterval.unref();
\tintervals.push(sessionInterval);
`
		: "";
	const sessionImport = isSession
		? `import { makeSessionSettleJob } from "./jobs/session-settle-job.js";\n`
		: "";

	return `import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import { Worker } from "bullmq";
import type { Env } from "../core/env.js";
${sessionImport}import { type ThingJobData, makeConnection } from "./queue.js";

export type WorkerRuntime = {
\tworker: Worker<ThingJobData>;
\tclose: () => Promise<void>;
};

/**
 * BullMQ worker + cron drivers. For session-intent scaffolds we also schedule
 * the on-chain close job so vouchers don't pile up in mppx's store forever.
 */
export const startWorkerRuntime = (env: Env, mpp: PaywrapMpp): WorkerRuntime => {
\tconst connection = makeConnection(env.REDIS_URL);
\tconst worker = new Worker<ThingJobData>(
\t\t"things",
\t\tasync (_job) => {
\t\t\t// TODO: implement — run your async provisioning work for job.data.thingId.
\t\t},
\t\t{ connection, concurrency: 5 },
\t);
\tconst intervals: NodeJS.Timeout[] = [];
${sessionCronBlock}
\treturn {
\t\tworker,
\t\tclose: async () => {
\t\t\tfor (const t of intervals) clearInterval(t);
\t\t\tawait worker.close();
\t\t},
\t};
};
`;
};

export const sessionSettleJobTemplate =
	(): string => `import { type PaywrapMpp, closeSessionOnChain } from "@zerorun/paywrap/mpp";
import type { Hex } from "viem";

/**
 * Close each open channel on-chain. Posts the highest voucher + finalizes
 * the channel in one tx — seller pays gas out of the wallet's USDC balance
 * (Tempo chain object has \`feeToken: USDC\` wired in by the kit).
 *
 * This scaffold cron has NO database — it has no way to enumerate channels.
 * Replace the empty \`channels\` list with \`await yourDb.listDistinctChannels()\`
 * once you've wired a Thing model with a \`channel_id\` column (see zero-redis-
 * integration's provision-service#listDistinctChannels for the reference).
 */
export const makeSessionSettleJob = (mpp: PaywrapMpp) => async () => {
\tconst channels: Hex[] = [];
\tfor (const channelId of channels) {
\t\ttry {
\t\t\tawait closeSessionOnChain(mpp, channelId);
\t\t} catch {
\t\t\t// swallow — next tick retries
\t\t}
\t}
};
`;
