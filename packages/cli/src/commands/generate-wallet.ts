import { generateWallet } from "@zeroclickai/paywrap/setup";

/** `paywrap generate-wallet` — pure output, pipe into `.env` or a secret manager. */
export const runGenerateWallet = (): void => {
	const wallet = generateWallet();
	process.stdout.write(
		`WALLET_PRIVATE_KEY=${wallet.privateKey}\nWALLET_ADDRESS=${wallet.address}\n`,
	);
};
