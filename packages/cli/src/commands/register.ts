import { registerWithZero } from "@zeroclickai/paywrap/setup";

/**
 * `paywrap register` — publish the deployed service to Zero's catalog. Env:
 * `ZERO_API_URL`, `PUBLIC_BASE_URL`, `WALLET_PRIVATE_KEY` (the last is
 * only read to prove it's set).
 */
export const runRegister = async (): Promise<void> => {
	const zeroApiUrl = process.env.ZERO_API_URL;
	const publicBaseUrl = process.env.PUBLIC_BASE_URL;
	const walletKey = process.env.WALLET_PRIVATE_KEY;
	if (!zeroApiUrl) throw new Error("ZERO_API_URL is required in env");
	if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required in env");
	if (!walletKey) throw new Error("WALLET_PRIVATE_KEY is required in env");

	const result = await registerWithZero({ zeroApiUrl, publicBaseUrl });
	process.stdout.write(`status: ${result.status}\nbody: ${result.body}\n`);
	if (!result.ok) process.exit(1);
};
