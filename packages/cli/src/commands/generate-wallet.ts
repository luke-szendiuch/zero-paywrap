import { generateWallet } from "@zerorun/paywrap/setup";

/**
 * `paywrap generate-wallet` — pure output, no side effects. Users typically
 * pipe this into their `.env` or secret manager.
 */
export const runGenerateWallet = (): void => {
	const wallet = generateWallet();
	process.stdout.write(
		`WALLET_PRIVATE_KEY=${wallet.privateKey}\nWALLET_ADDRESS=${wallet.address}\n`,
	);
};
