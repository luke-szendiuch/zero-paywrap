import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const appContextTemplate = (config: ScaffoldConfig): string => {
	// In private-key mode the scaffolder wires `createPaywrapMpp({ walletPrivateKey })`,
	// which returns `PaywrapMppKeyed` — `mppxClient` and `mppxAccount` are non-optional.
	// In address-only mode there's no signing account, so we narrow to the base
	// `PaywrapMpp` and omit `mppxAccount`.
	const addressOnly = config.walletMode === "address-only";
	const mppType = addressOnly ? "PaywrapMpp" : "PaywrapMppKeyed";
	const imports: string[] = [
		`import type { ${mppType} } from "@zeroclickai/paywrap/mpp";`,
		`import type { Env } from "../core/env.js";`,
	];
	const fields: string[] = [
		"\tenv: Env;",
		"\twalletAddress: `0x${string}`;",
		`\tmppx: ${mppType}["mppx"];`,
		`\tchannelStore: ${mppType}["channelStore"];`,
	];
	if (!addressOnly) {
		fields.push(`\tmppxClient: PaywrapMppKeyed["client"];`);
		fields.push(`\tmppxAccount: PaywrapMppKeyed["account"];`);
	}
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
