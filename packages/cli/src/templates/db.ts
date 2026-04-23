import type { ScaffoldConfig } from "../lib/scaffold-config.js";

export const dbClientTemplate = (): string => `import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export const makePgPool = (url: string) => new pg.Pool({ connectionString: url });
export const makeDb = (pool: pg.Pool) => drizzle({ client: pool, casing: "snake_case" });
export type Db = ReturnType<typeof makeDb>;
`;

export const dbMigrateTemplate = (): string => `import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parseEnv } from "../core/env.js";
import { makeDb, makePgPool } from "./client.js";

const main = async () => {
\tconst env = parseEnv(process.env);
\tconst pool = makePgPool(env.DATABASE_URL);
\tconst db = makeDb(pool);
\tawait migrate(db, { migrationsFolder: "./drizzle" });
\tawait pool.end();
};

main().catch((e) => {
\tconsole.error(e);
\tprocess.exit(1);
});
`;

export const drizzleConfigTemplate = (): string => `import { defineConfig } from "drizzle-kit";

export default defineConfig({
\tdialect: "postgresql",
\tschema: "./src/models/thing.ts",
\tout: "./drizzle",
\tcasing: "snake_case",
});
`;

export const thingModelTemplate = (config: ScaffoldConfig): string => {
	const isSession = config.intent === "session";
	const extraFields = isSession
		? `\n\t\tchannelId: text(),\n\t\tvoucherCumulativeAmount: bigint({ mode: "bigint" }),\n\t\texpiresAt: timestamp({ withTimezone: true }),`
		: "";
	return `import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Generic resource the scaffold creates on POST. Extend this with your domain
 * columns — payment accounting (channelId / voucherCumulativeAmount) is
 * prewired for session-intent scaffolds.
 */
export const things = pgTable(
\t"things",
\t{
\t\tid: text().primaryKey(),
\t\tpayerAddress: text().notNull(),
\t\tstate: text({
\t\t\tenum: ["provisioning", "ready", "failed", "terminated"],
\t\t}).notNull(),${extraFields}
\t\tcreatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
\t},
\t(t) => [index("things_payer_idx").on(t.payerAddress)],
);

export type Thing = typeof things.$inferSelect;
`;
};
