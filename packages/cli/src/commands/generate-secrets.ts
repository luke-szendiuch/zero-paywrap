import { generateMppSecretKey, generateWallet } from "@zeroclickai/paywrap/setup";

/**
 * `paywrap generate-secrets` — emit a wallet keypair AND a fresh MPP HMAC
 * in a single call, formatted for direct paste into a `.env` file or a
 * secret manager.
 *
 * Why this exists: every new paywrap service needs three of the same things
 * — `WALLET_PRIVATE_KEY`, `WALLET_ADDRESS`, `MPP_SECRET_KEY`. The split
 * `generate-wallet` + `openssl rand -hex 32` flow worked but was two
 * commands and one of them came from outside paywrap. One-stop now.
 *
 * Output is plain key=value lines on stdout, intentionally pipeable:
 *
 *   $ paywrap generate-secrets > .env
 *
 * No prompts, no extras.
 */
export const runGenerateSecrets = (): void => {
	const wallet = generateWallet();
	const mppSecretKey = generateMppSecretKey();
	process.stdout.write(
		`WALLET_PRIVATE_KEY=${wallet.privateKey}\nWALLET_ADDRESS=${wallet.address}\nMPP_SECRET_KEY=${mppSecretKey}\n`,
	);
};
