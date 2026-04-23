import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { generateMppSecretKey, generateWallet, prefundWallet } from "@zerorun/paywrap/setup";
import { type Prompter, makeClackPrompter } from "../lib/prompter.js";
import type {
	HostingHint,
	HttpFramework,
	PaymentIntent,
	QueueChoice,
	ScaffoldConfig,
	StorageChoice,
} from "../lib/scaffold-config.js";
import { buildScaffoldFileMap, writeScaffoldFiles } from "../lib/write-scaffold.js";

/** Default fill-ins used by `--yes` and any skipped prompt. */
const DEFAULTS = {
	intent: "session" as PaymentIntent,
	priceUsdc: "0.02",
	durationSeconds: 2_592_000,
	framework: "fastify" as HttpFramework,
	storage: "postgres-drizzle" as StorageChoice,
	queue: "bullmq-redis" as QueueChoice,
	hosting: "skip" as HostingHint,
	generateWalletNow: true,
};

export type CreateOptions = {
	yes?: boolean;
	/** Override the default prompter for testing. */
	prompter?: Prompter;
	skipInstall?: boolean;
	/** External-process runners — tests stub these out. */
	runPnpmInstall?: (cwd: string) => Promise<void>;
	runGitInit?: (cwd: string) => Promise<void>;
};

/**
 * `paywrap create [dir]` — interactive scaffolder. Writes a complete
 * paid-API service into `dir`, optionally generates + prefunds a wallet,
 * optionally installs + commits.
 */
export const runCreate = async (
	dir: string | undefined,
	opts: CreateOptions = {},
): Promise<{ config: ScaffoldConfig; targetDir: string }> => {
	const targetDir = resolve(dir ?? "paywrap-service");
	const prompter = opts.prompter ?? makeClackPrompter();
	const useDefaults = Boolean(opts.yes);

	const defaultServiceName = toKebab(basename(targetDir));
	const serviceName = useDefaults
		? defaultServiceName
		: await prompter.text({
				name: "serviceName",
				message: "Service name (kebab-case)",
				defaultValue: defaultServiceName,
			});

	const intent = useDefaults
		? DEFAULTS.intent
		: await prompter.select<PaymentIntent>({
				name: "intent",
				message: "Payment intent",
				defaultValue: DEFAULTS.intent,
				options: [
					{ value: "session", label: "session — many requests per paid channel" },
					{ value: "charge", label: "charge — one-shot payment per call" },
				],
			});

	const priceUsdc = useDefaults
		? DEFAULTS.priceUsdc
		: await prompter.text({
				name: "priceUsdc",
				message: "Price per payment (USDC)",
				defaultValue: DEFAULTS.priceUsdc,
			});

	const scope = useDefaults
		? `${serviceName}:1`
		: await prompter.text({
				name: "scope",
				message: "Scope string",
				defaultValue: `${serviceName}:1`,
			});

	const durationSeconds = Number(
		useDefaults
			? DEFAULTS.durationSeconds
			: await prompter.text({
					name: "durationSeconds",
					message: "Session duration (seconds)",
					defaultValue: String(DEFAULTS.durationSeconds),
				}),
	);

	const framework = useDefaults
		? DEFAULTS.framework
		: await prompter.select<HttpFramework>({
				name: "framework",
				message: "HTTP framework",
				defaultValue: DEFAULTS.framework,
				options: [
					{ value: "fastify", label: "fastify" },
					{ value: "none", label: "none (bring your own)" },
				],
			});

	const storage = useDefaults
		? DEFAULTS.storage
		: await prompter.select<StorageChoice>({
				name: "storage",
				message: "Storage",
				defaultValue: DEFAULTS.storage,
				options: [
					{ value: "postgres-drizzle", label: "postgres + drizzle" },
					{ value: "none", label: "none" },
				],
			});

	const queue = useDefaults
		? DEFAULTS.queue
		: await prompter.select<QueueChoice>({
				name: "queue",
				message: "Queue",
				defaultValue: DEFAULTS.queue,
				options: [
					{ value: "bullmq-redis", label: "bullmq + redis" },
					{ value: "none", label: "none" },
				],
			});

	const hosting = useDefaults
		? DEFAULTS.hosting
		: await prompter.select<HostingHint>({
				name: "hosting",
				message: "Hosting hint (.env.example comments only)",
				defaultValue: DEFAULTS.hosting,
				options: [
					{ value: "render", label: "render" },
					{ value: "fly", label: "fly" },
					{ value: "railway", label: "railway" },
					{ value: "docker", label: "docker" },
					{ value: "skip", label: "skip" },
				],
			});

	const generateWalletNow = useDefaults
		? DEFAULTS.generateWalletNow
		: await prompter.confirm({
				name: "generateWalletNow",
				message: "Generate a wallet now?",
				defaultValue: true,
			});

	const wallet = generateWalletNow ? generateWallet() : undefined;

	// Prefund is session-only (seller needs USDC float for close gas).
	let prefundTxHash: `0x${string}` | undefined;
	if (!useDefaults && intent === "session" && wallet) {
		const wantsPrefund = await prompter.confirm({
			name: "prefundWallet",
			message: "Prefund this wallet now? (requires a source private key with USDC on Tempo)",
			defaultValue: false,
		});
		if (wantsPrefund) {
			const fromKey = await prompter.text({
				name: "prefundFromPrivateKey",
				message: "Source private key (0x + 64 hex)",
			});
			const rpc = await prompter.text({
				name: "prefundRpc",
				message: "Tempo RPC URL",
				defaultValue: "https://rpc.tempo.xyz",
			});
			const amountMicroStr = await prompter.text({
				name: "prefundAmountMicro",
				message: "Amount in micro-USDC (50000 = 0.05 USDC)",
				defaultValue: "50000",
			});
			prefundTxHash = await prefundWallet({
				fromPrivateKey: fromKey as `0x${string}`,
				to: wallet.address,
				tempoRpcUrl: rpc,
				amountUsdcMicro: BigInt(amountMicroStr),
			});
		}
	}

	const config: ScaffoldConfig = {
		targetDir,
		serviceName,
		intent,
		priceUsdc,
		scope,
		durationSeconds,
		framework,
		storage,
		queue,
		hosting,
		generateWalletNow,
		...(wallet ? { wallet } : {}),
		...(prefundTxHash ? { prefundTxHash } : {}),
	};

	if (existsSync(targetDir)) {
		// Write overwrites files; caller should've chosen an empty dir. Only
		// guard against the clearly-wrong case of writing into our own source.
		const abs = resolve(targetDir);
		if (abs.endsWith("packages/cli") || abs.endsWith("packages/kit")) {
			throw new Error(`refusing to scaffold into workspace package dir: ${abs}`);
		}
	}

	const files = buildScaffoldFileMap(config);

	// Append the MPP secret to the generated .env so the scaffold runs out
	// of the box without another CLI call.
	if (wallet) {
		const existing = files[".env"] ?? "";
		const mppKey = generateMppSecretKey();
		files[".env"] = `${existing}MPP_SECRET_KEY=${mppKey}\n`;
	}

	await writeScaffoldFiles(targetDir, files);

	if (!opts.skipInstall && opts.runPnpmInstall) {
		try {
			await opts.runPnpmInstall(targetDir);
		} catch (err) {
			process.stderr.write(
				`pnpm install failed — you can re-run it manually: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	if (opts.runGitInit) {
		try {
			await opts.runGitInit(targetDir);
		} catch {
			// git is optional — don't explode the scaffold on a missing binary.
		}
	}

	return { config, targetDir };
};

/** Lower-case, non-alphanumerics collapsed to a single dash, trimmed. */
export const toKebab = (s: string): string =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-") || "my-paywrap-service";
