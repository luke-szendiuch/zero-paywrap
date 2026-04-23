import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const cliPath = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist/cli.js");

describe("paywrap generate-wallet", () => {
	it("prints WALLET_PRIVATE_KEY + WALLET_ADDRESS in env-style", async () => {
		const { stdout } = await execa("node", [cliPath, "generate-wallet"]);
		const lines = stdout.trim().split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0]).toMatch(/^WALLET_PRIVATE_KEY=0x[0-9a-f]{64}$/);
		expect(lines[1]).toMatch(/^WALLET_ADDRESS=0x[0-9a-fA-F]{40}$/);
	});

	it("produces a distinct keypair on each call", async () => {
		const { stdout: a } = await execa("node", [cliPath, "generate-wallet"]);
		const { stdout: b } = await execa("node", [cliPath, "generate-wallet"]);
		expect(a).not.toBe(b);
	});
});
