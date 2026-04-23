#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { execa } from "execa";
import { runCheck } from "./commands/check.js";
import { runCreate } from "./commands/create.js";
import { runGenerateWallet } from "./commands/generate-wallet.js";
import { runPrefund } from "./commands/prefund.js";
import { runRegister } from "./commands/register.js";

// Each subcommand delegates to a `run*` function in `./commands/`. Keep this
// file dumb so tests can exercise commands without spawning a child process.
const program = new Command();

program
	.name("paywrap")
	.description("Scaffold + operate @zerorun/paywrap services")
	.version("0.0.1");

program
	.command("create [dir]")
	.description("Scaffold a new paid service")
	.option("--yes", "Skip all prompts and use defaults")
	.option("--non-interactive-defaults", "Alias for --yes (dogfooding smoke-test flag)")
	.option("--skip-install", "Skip `pnpm install` after scaffolding")
	.action(
		async (
			dir: string | undefined,
			opts: { yes?: boolean; nonInteractiveDefaults?: boolean; skipInstall?: boolean },
		) => {
			const yes = Boolean(opts.yes || opts.nonInteractiveDefaults);
			const result = await runCreate(dir, {
				yes,
				...(opts.skipInstall ? { skipInstall: true } : {}),
				runPnpmInstall: async (cwd) => {
					await execa("pnpm", ["install"], { cwd, stdio: "inherit" });
					// Templates can't anticipate every biome reflow, so format the
					// scaffold after deps are installed — cheap, and makes the
					// scaffold's first `pnpm lint` a clean pass.
					try {
						await execa("pnpm", ["exec", "biome", "check", "--write", "--unsafe", "."], {
							cwd,
							stdio: "ignore",
						});
					} catch {
						// biome exits non-zero on unfixable issues; not fatal.
					}
				},
				runGitInit: async (cwd) => {
					await execa("git", ["init"], { cwd, stdio: "ignore" });
					await execa("git", ["add", "-A"], { cwd, stdio: "ignore" });
					await execa("git", ["commit", "-m", "Initial scaffold"], {
						cwd,
						stdio: "ignore",
					});
				},
			});
			process.stdout.write(
				`\nScaffold complete at ${result.targetDir}\n  service: ${result.config.serviceName}\n  intent: ${result.config.intent}\n`,
			);
			if (result.config.wallet) {
				process.stdout.write(`  wallet: ${result.config.wallet.address}\n`);
			}
			if (result.config.prefundTxHash) {
				process.stdout.write(`  prefund tx: ${result.config.prefundTxHash}\n`);
			}
			process.stdout.write("\nNext steps:\n");
			process.stdout.write(`  cd ${result.targetDir}\n`);
			if (!yes && !opts.skipInstall) {
				process.stdout.write("  review .env, then pnpm dev\n");
			} else {
				process.stdout.write("  pnpm install && pnpm dev\n");
			}
		},
	);

program
	.command("generate-wallet")
	.description("Print WALLET_PRIVATE_KEY + WALLET_ADDRESS for a fresh keypair")
	.action(() => {
		runGenerateWallet();
	});

program
	.command("prefund <address>")
	.description("Send USDC on Tempo from WALLET_PRIVATE_KEY to <address>")
	.option("--amount-micro <n>", "Amount in micro-USDC (default 50000 = 0.05 USDC)")
	.action(async (address: string, opts: { amountMicro?: string }) => {
		await runPrefund(address, {
			...(opts.amountMicro !== undefined ? { amountMicro: BigInt(opts.amountMicro) } : {}),
		});
	});

program
	.command("register")
	.description("Publish this service to Zero's catalog")
	.action(async () => {
		await runRegister();
	});

program
	.command("check <url>")
	.description("Fetch <url>/healthz and <url>/.well-known/paywrap.json")
	.action(async (url: string) => {
		await runCheck(url);
	});

program.parseAsync(process.argv).catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
