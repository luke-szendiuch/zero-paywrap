import { randomBytes } from "node:crypto";
import { http, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoChain } from "../mpp/chain.js";
import { TEMPO_USDC } from "../mpp/constants.js";

// Programmatic counterparts to the `paywrap` CLI commands. Safe from a Node
// script or one-off setup page.

export type WalletKeypair = {
	privateKey: `0x${string}`;
	address: `0x${string}`;
};

export const generateWallet = (): WalletKeypair => {
	const privateKey = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
	const address = privateKeyToAccount(privateKey).address;
	return { privateKey, address };
};

/**
 * 32-byte HMAC secret for mppx (`MPP_SECRET_KEY`). Per-deployment key that
 * binds challenge ids to this server. Rotating it invalidates all in-flight
 * MPP sessions — do it during a maintenance window.
 */
export const generateMppSecretKey = (): string => randomBytes(32).toString("hex");

export type PrefundWalletParams = {
	fromPrivateKey: `0x${string}`;
	to: `0x${string}`;
	/** Raw USDC micro-units (6 decimals). Default 50_000 = 0.05 USDC. */
	amountUsdcMicro?: bigint;
	tempoRpcUrl: string;
};

/**
 * Send USDC on Tempo to bootstrap a new service wallet. Only needed for MPP
 * **session** services — seller pays close gas per channel (~0.002 USDC).
 * Charge-based services never need prefunding (buyer pays all gas). Uses
 * `feeToken: USDC` via `tempoChain` so source wallet needs no native either.
 */
export const prefundWallet = async (params: PrefundWalletParams): Promise<`0x${string}`> => {
	const account = privateKeyToAccount(params.fromPrivateKey);
	const client = createWalletClient({
		account,
		chain: tempoChain,
		transport: http(params.tempoRpcUrl),
	});
	// biome-ignore lint/suspicious/noExplicitAny: tempoChain is typed `any` (custom feeToken field); writeContract's chain generic cannot infer through it
	return (client as any).writeContract({
		address: TEMPO_USDC,
		abi: erc20Abi,
		functionName: "transfer",
		args: [params.to, params.amountUsdcMicro ?? 50_000n],
	});
};

export type RegisterWithZeroParams = {
	zeroApiUrl: string;
	publicBaseUrl: string;
	protocol?: "mpp" | "x402";
};

/**
 * Publish a deployed service to Zero's catalog. Call once per deployment
 * after the URL is live and `/.well-known/paywrap.json` resolves.
 */
export const registerWithZero = async (
	params: RegisterWithZeroParams,
): Promise<{ ok: boolean; status: number; body: string }> => {
	const r = await fetch(`${params.zeroApiUrl}/v1/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			url: params.publicBaseUrl,
			protocol: params.protocol ?? "mpp",
		}),
	});
	return { ok: r.ok, status: r.status, body: await r.text() };
};
