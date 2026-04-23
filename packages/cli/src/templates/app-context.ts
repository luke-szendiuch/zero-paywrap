import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const appContextTemplate = (config: ScaffoldConfig): string => {
	const imports: string[] = [
		`import type { PaywrapMpp } from "@zerorun/paywrap/mpp";`,
		`import type { Env } from "../core/env.js";`,
	];
	const fields: string[] = [
		"\tenv: Env;",
		"\twalletAddress: `0x${string}`;",
		`\tmppx: PaywrapMpp["mppx"];`,
		`\tchannelStore: PaywrapMpp["channelStore"];`,
		`\tmppxClient: PaywrapMpp["client"];`,
		`\tmppxAccount: PaywrapMpp["account"];`,
	];
	if (config.storage === "postgres-drizzle") {
		imports.push(`import type { Db } from "../db/client.js";`);
		fields.push("\tdb: Db;");
	}
	if (config.queue === "bullmq-redis") {
		imports.push(`import type IORedis from "ioredis";`);
		imports.push(`import type { Queues } from "../worker/queue.js";`);
		fields.push("\tqueues: Queues;");
		fields.push("\tmppxRedis: IORedis | null;");
	}

	return `${imports.join("\n")}

export type AppContext = {
${fields.join("\n")}
};
`;
};
