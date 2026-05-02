import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const appContextTemplate = (config: ScaffoldConfig): string => {
	// The CLI scaffolder always wires `createPaywrapMpp({ walletPrivateKey: ... })`,
	// so the runtime bundle is always full mode. Reference `PaywrapMppKeyed` here
	// so `mppxClient` and `mppxAccount` stay non-optional in the emitted context
	// type — using the union (`PaywrapMpp`) widens both to `… | undefined` and
	// silently degrades downstream call sites that destructure them.
	const imports: string[] = [
		`import type { PaywrapMppKeyed } from "@zeroclickai/paywrap/mpp";`,
		`import type { Env } from "../core/env.js";`,
	];
	const fields: string[] = [
		"\tenv: Env;",
		"\twalletAddress: `0x${string}`;",
		`\tmppx: PaywrapMppKeyed["mppx"];`,
		`\tchannelStore: PaywrapMppKeyed["channelStore"];`,
		`\tmppxClient: PaywrapMppKeyed["client"];`,
		`\tmppxAccount: PaywrapMppKeyed["account"];`,
	];
	if (config.intent === "charge") {
		imports.push(`import type { ResourceClient } from "../services/thing-client.js";`);
		fields.push("\tresourceClient: ResourceClient;");
	} else if (config.storage === "postgres-drizzle") {
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
