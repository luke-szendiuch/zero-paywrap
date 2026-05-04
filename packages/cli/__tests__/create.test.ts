import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCreate, toKebab } from "../src/commands/create.js";
import { makeStubPrompter } from "../src/lib/prompter.js";

const makeTmpDir = (label: string) =>
	join(
		tmpdir(),
		`paywrap-cli-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);

describe("toKebab", () => {
	it("lowercases and collapses separators", () => {
		expect(toKebab("My Service")).toBe("my-service");
		expect(toKebab("My_Service!")).toBe("my-service");
	});
	it("falls back when input has no alphanumerics", () => {
		expect(toKebab("!!!")).toBe("my-paywrap-service");
	});
});

describe("runCreate (session + postgres + bullmq)", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("session-full");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("writes the expected file set with session-intent extras", async () => {
		const prompter = makeStubPrompter({
			serviceName: "test-svc",
			intent: "session",
			priceUsdc: "0.05",
			scope: "test-svc:1",
			durationSeconds: "3600",
			framework: "fastify",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "render",
			generateWalletNow: true,
			prefundWallet: false,
		});
		const result = await runCreate(target, { prompter, skipInstall: true });
		expect(result.config.serviceName).toBe("test-svc");
		expect(result.config.intent).toBe("session");
		expect(result.config.priceUsdc).toBe("0.05");
		expect(result.config.wallet?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

		for (const rel of [
			"package.json",
			"tsconfig.json",
			"biome.json",
			"vitest.config.ts",
			".env.example",
			"README.md",
			"Dockerfile",
			"src/index.ts",
			"src/app/app-context.ts",
			"src/app/build-app.ts",
			"src/core/env.ts",
			"src/routes/things.ts",
			"src/routes/health.ts",
			"src/routes/wellknown.ts",
			"src/setup/index.ts",
			"src/db/client.ts",
			"src/db/migrate.ts",
			"src/models/thing.ts",
			"drizzle.config.ts",
			"src/worker/queue.ts",
			"src/worker/start.ts",
			"src/worker/index.ts",
			"src/worker/jobs/session-settle-job.ts",
		]) {
			expect(existsSync(join(target, rel)), `expected ${rel}`).toBe(true);
		}
	});

	it("generated package.json includes the expected deps", async () => {
		const prompter = makeStubPrompter({
			serviceName: "test-svc",
			intent: "session",
			priceUsdc: "0.02",
			scope: "test-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "skip",
			generateWalletNow: true,
			prefundWallet: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		for (const dep of [
			"@zeroclickai/paywrap",
			"mppx",
			"viem",
			"zod",
			"fastify",
			"fastify-type-provider-zod",
			"drizzle-orm",
			"pg",
			"bullmq",
			"ioredis",
			"dotenv",
		]) {
			expect(pkg.dependencies[dep], dep).toBeDefined();
		}
		expect(pkg.scripts.dev).toBe("tsx watch src/index.ts");
		expect(pkg.scripts["db:migrate"]).toBe("tsx src/db/migrate.ts");
		expect(pkg.scripts["dev:worker"]).toBe("tsx watch src/worker/index.ts");
	});

	it(".env.example contains every documented key", async () => {
		const prompter = makeStubPrompter({
			serviceName: "test-svc",
			intent: "session",
			priceUsdc: "0.02",
			scope: "test-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "render",
			generateWalletNow: true,
			prefundWallet: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		const env = readFileSync(join(target, ".env.example"), "utf8");
		for (const key of [
			"PUBLIC_BASE_URL",
			"WALLET_PRIVATE_KEY",
			"MPP_SECRET_KEY",
			"TEMPO_RPC_URL",
			"ZERO_API_URL",
			"SKU_PRICE_USDC_MICRO",
			"SKU_DURATION_SECONDS",
			"DATABASE_URL",
			"REDIS_URL",
			"RUN_WORKER",
		]) {
			expect(env.includes(key), key).toBe(true);
		}
		expect(env.includes("Render gotchas")).toBe(true);
	});

	it("README exists and mentions the intent + scope", async () => {
		const prompter = makeStubPrompter({
			serviceName: "test-svc",
			intent: "session",
			priceUsdc: "0.02",
			scope: "test-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "skip",
			generateWalletNow: true,
			prefundWallet: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		const readme = readFileSync(join(target, "README.md"), "utf8");
		expect(readme.includes("# test-svc")).toBe(true);
		expect(readme.includes("session")).toBe(true);
		expect(readme.includes("test-svc:1")).toBe(true);
	});

	it("pre-seeds .env with wallet + MPP_SECRET_KEY when wallet is generated", async () => {
		const prompter = makeStubPrompter({
			serviceName: "test-svc",
			intent: "session",
			priceUsdc: "0.02",
			scope: "test-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "skip",
			generateWalletNow: true,
			prefundWallet: false,
		});
		const result = await runCreate(target, { prompter, skipInstall: true });
		const env = readFileSync(join(target, ".env"), "utf8");
		expect(env.includes(`WALLET_PRIVATE_KEY=${result.config.wallet?.privateKey}`)).toBe(true);
		expect(env.includes("MPP_SECRET_KEY=")).toBe(true);
	});
});

describe("runCreate (charge intent)", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("charge");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("skips /extend route and session-settle job", async () => {
		const prompter = makeStubPrompter({
			serviceName: "charge-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "charge-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "none",
			queue: "none",
			hosting: "skip",
			generateWalletNow: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		expect(existsSync(join(target, "src/worker/jobs/session-settle-job.ts"))).toBe(false);
		expect(existsSync(join(target, "src/db/client.ts"))).toBe(false);
		expect(existsSync(join(target, "src/worker/queue.ts"))).toBe(false);
		const things = readFileSync(join(target, "src/routes/things.ts"), "utf8");
		expect(things.includes("/extend")).toBe(false);
	});

	it("uses the charge-intent fastify adapter helpers (NOT session ones) for charge intent", async () => {
		const prompter = makeStubPrompter({
			serviceName: "charge-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "charge-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "none",
			queue: "none",
			hosting: "skip",
			generateWalletNow: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		const things = readFileSync(join(target, "src/routes/things.ts"), "utf8");
		expect(things.includes("sendChargeChallenge")).toBe(true);
		expect(things.includes("sendSessionChallenge")).toBe(false);
	});

	it("writes a stateless-scaffold signal (no DB model, no drizzle deps, thing-client stub) for charge intent", async () => {
		const prompter = makeStubPrompter({
			serviceName: "charge-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "charge-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			// User picks postgres-drizzle at the prompt but charge overrides it.
			storage: "postgres-drizzle",
			queue: "none",
			hosting: "skip",
			generateWalletNow: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		// No drizzle or pg deps in package.json.
		const pkg = readFileSync(join(target, "package.json"), "utf8");
		expect(pkg.includes("drizzle-orm")).toBe(false);
		expect(pkg.includes('"pg"')).toBe(false);
		expect(pkg.includes("drizzle-kit")).toBe(false);
		// No db/ or models/ files on disk.
		expect(existsSync(join(target, "src/db/client.ts"))).toBe(false);
		expect(existsSync(join(target, "src/models/thing.ts"))).toBe(false);
		expect(existsSync(join(target, "drizzle.config.ts"))).toBe(false);
		// The stateless typed-client stub IS present.
		expect(existsSync(join(target, "src/services/thing-client.ts"))).toBe(true);
		// No DATABASE_URL in env schema or example.
		const envSchema = readFileSync(join(target, "src/core/env.ts"), "utf8");
		expect(envSchema.includes("DATABASE_URL")).toBe(false);
		const envExample = readFileSync(join(target, ".env.example"), "utf8");
		expect(envExample.includes("DATABASE_URL")).toBe(false);
	});
});

describe("runCreate (minimal: fastify + no storage + no queue)", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("minimal");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("emits a valid package.json without pg / bullmq deps", async () => {
		const prompter = makeStubPrompter({
			serviceName: "mini-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "mini-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "none",
			queue: "none",
			hosting: "skip",
			generateWalletNow: false,
		});
		await runCreate(target, { prompter, skipInstall: true });
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		expect(pkg.dependencies.fastify).toBeDefined();
		expect(pkg.dependencies["drizzle-orm"]).toBeUndefined();
		expect(pkg.dependencies.bullmq).toBeUndefined();
		expect(pkg.dependencies.pg).toBeUndefined();
		expect(pkg.scripts["db:migrate"]).toBeUndefined();
		expect(pkg.scripts["dev:worker"]).toBeUndefined();
	});
});

describe("runCreate (charge + address-only)", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("addr-only");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("emits WALLET_ADDRESS (not WALLET_PRIVATE_KEY) and address-only mpp wiring", async () => {
		const prompter = makeStubPrompter({
			serviceName: "ao-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "ao-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "none",
			queue: "none",
			hosting: "skip",
			walletMode: "address-only",
			generateWalletNow: true,
		});
		const result = await runCreate(target, { prompter, skipInstall: true });
		expect(result.config.walletMode).toBe("address-only");

		const envSchema = readFileSync(join(target, "src/core/env.ts"), "utf8");
		expect(envSchema.includes("WALLET_ADDRESS")).toBe(true);
		expect(envSchema.includes("WALLET_PRIVATE_KEY")).toBe(false);

		const envExample = readFileSync(join(target, ".env.example"), "utf8");
		expect(envExample.includes("WALLET_ADDRESS=")).toBe(true);
		expect(envExample.includes("WALLET_PRIVATE_KEY=")).toBe(false);

		// Pre-seeded .env must not persist the private key.
		const envFile = readFileSync(join(target, ".env"), "utf8");
		expect(envFile.includes("WALLET_PRIVATE_KEY=")).toBe(false);
		expect(envFile.includes("WALLET_ADDRESS=")).toBe(true);

		const indexEntry = readFileSync(join(target, "src/index.ts"), "utf8");
		expect(indexEntry.includes("walletAddress: env.WALLET_ADDRESS")).toBe(true);
		expect(indexEntry.includes("walletPrivateKey")).toBe(false);

		const ctx = readFileSync(join(target, "src/app/app-context.ts"), "utf8");
		expect(ctx.includes("PaywrapMpp")).toBe(true);
		expect(ctx.includes("PaywrapMppKeyed")).toBe(false);
		expect(ctx.includes("mppxAccount")).toBe(false);
	});

	it("session intent ignores address-only choice (always private-key)", async () => {
		const prompter = makeStubPrompter({
			serviceName: "sess-svc",
			intent: "session",
			priceUsdc: "0.02",
			scope: "sess-svc:1",
			durationSeconds: "2592000",
			framework: "fastify",
			storage: "none",
			queue: "none",
			hosting: "skip",
			walletMode: "address-only",
			generateWalletNow: true,
			prefundWallet: false,
		});
		const result = await runCreate(target, { prompter, skipInstall: true });
		expect(result.config.walletMode).toBe("private-key");
	});
});

describe("runCreate (hono-workers framework)", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("hono-workers");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("emits a Workers-flavored file set and skips fastify scaffolding", async () => {
		const prompter = makeStubPrompter({
			serviceName: "wkr-svc",
			intent: "charge",
			priceUsdc: "0.02",
			scope: "wkr-svc:1",
			durationSeconds: "2592000",
			framework: "hono-workers",
			walletMode: "address-only",
			generateWalletNow: true,
			hosting: "skip",
		});
		await runCreate(target, { prompter, skipInstall: true });

		// Workers-only files exist…
		for (const rel of [
			"package.json",
			"tsconfig.json",
			"wrangler.toml",
			".dev.vars.example",
			"src/worker.ts",
			"README.md",
		]) {
			expect(existsSync(join(target, rel)), `expected ${rel}`).toBe(true);
		}
		// …and Node-style scaffolding does NOT.
		for (const rel of [
			"src/index.ts",
			"src/app/build-app.ts",
			"src/routes/things.ts",
			"src/core/env.ts",
			"Dockerfile",
		]) {
			expect(existsSync(join(target, rel)), `should not emit ${rel}`).toBe(false);
		}

		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		expect(pkg.dependencies["@zeroclickai/paywrap-adapter-hono"]).toBeDefined();
		expect(pkg.dependencies.hono).toBeDefined();
		expect(pkg.devDependencies.wrangler).toBeDefined();
		expect(pkg.dependencies.fastify).toBeUndefined();

		const wrangler = readFileSync(join(target, "wrangler.toml"), "utf8");
		expect(wrangler.includes("nodejs_compat")).toBe(true);

		const worker = readFileSync(join(target, "src/worker.ts"), "utf8");
		expect(worker.includes("walletAddress: env.WALLET_ADDRESS")).toBe(true);
		expect(worker.includes("mppGated")).toBe(true);
	});

	it("forces charge intent + skips storage/queue when picking hono-workers", async () => {
		const prompter = makeStubPrompter({
			serviceName: "wkr-sess",
			intent: "session",
			priceUsdc: "0.02",
			scope: "wkr-sess:1",
			durationSeconds: "2592000",
			framework: "hono-workers",
			storage: "postgres-drizzle",
			queue: "bullmq-redis",
			hosting: "skip",
			walletMode: "address-only",
			generateWalletNow: false,
		});
		const result = await runCreate(target, { prompter, skipInstall: true });
		expect(result.config.intent).toBe("charge");
		expect(result.config.storage).toBe("none");
		expect(result.config.queue).toBe("none");
	});
});

describe("runCreate with --yes / defaults", () => {
	let target = "";
	beforeEach(() => {
		target = makeTmpDir("yes");
	});
	afterEach(() => {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	});

	it("produces a full scaffold without any prompts", async () => {
		const result = await runCreate(target, { yes: true, skipInstall: true });
		expect(result.config.intent).toBe("session");
		expect(result.config.storage).toBe("postgres-drizzle");
		expect(result.config.queue).toBe("bullmq-redis");
		expect(result.config.framework).toBe("fastify");
		expect(existsSync(join(target, "src/index.ts"))).toBe(true);
	});
});
