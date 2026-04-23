import { prefundWallet } from "@zeroclickai/paywrap/setup";

export type PrefundOptions = {
	amountMicro?: bigint;
};

/**
 * `paywrap prefund <address>` — send USDC on Tempo from `WALLET_PRIVATE_KEY`
 * to `address`. Env: `WALLET_PRIVATE_KEY`, `TEMPO_RPC_URL`. Default amount
 * is 50_000 micro-USDC (0.05 USDC), same as the kit default.
 */
export const runPrefund = async (address: string, opts: PrefundOptions): Promise<void> => {
	const fromKey = process.env.WALLET_PRIVATE_KEY;
	const rpc = process.env.TEMPO_RPC_URL;
	if (!fromKey) throw new Error("WALLET_PRIVATE_KEY is required in env");
	if (!rpc) throw new Error("TEMPO_RPC_URL is required in env");
	if (!/^0x[0-9a-fA-F]{64}$/.test(fromKey)) {
		throw new Error("WALLET_PRIVATE_KEY must be 0x + 64 hex chars");
	}
	if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
		throw new Error(`invalid destination address: ${address}`);
	}

	const txHash = await prefundWallet({
		fromPrivateKey: fromKey as `0x${string}`,
		to: address as `0x${string}`,
		tempoRpcUrl: rpc,
		...(opts.amountMicro !== undefined ? { amountUsdcMicro: opts.amountMicro } : {}),
	});
	process.stdout.write(`${txHash}\n`);
};
