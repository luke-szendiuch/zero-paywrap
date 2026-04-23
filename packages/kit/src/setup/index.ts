import { randomBytes } from "node:crypto";
import { http, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoChain } from "../mpp/chain.js";
import { TEMPO_USDC } from "../mpp/constants.js";

/**
 * Setup utilities — programmatic counterparts to the `paywrap` CLI commands.
 * All of these are safe to call from a Node script or a one-off setup page.
 */

export type WalletKeypair = {
	privateKey: `0x${string}`;
	address: `0x${string}`;
};

/** Generate a random service wallet keypair. */
export const generateWallet = (): WalletKeypair => {
	const privateKey = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
	const address = privateKeyToAccount(privateKey).address;
	return { privateKey, address };
};

/**
 * Generate a random 32-byte HMAC secret for mppx (`MPP_SECRET_KEY`).
 *
 * This is the per-deployment key that binds challenge ids to this server.
 * Changing it invalidates all in-flight MPP sessions — rotate only during a
 * maintenance window.
 */
export const generateMppSecretKey = (): string => randomBytes(32).toString("hex");

export type PrefundWalletParams = {
	/** Source wallet private key (must hold USDC on Tempo). */
	fromPrivateKey: `0x${string}`;
	/** Destination address — typically the new service wallet. */
	to: `0x${string}`;
	/** Amount in raw USDC micro-units (6 decimals). Default: 50_000 = 0.05 USDC. */
	amountUsdcMicro?: bigint;
	/** Tempo RPC URL. */
	tempoRpcUrl: string;
};

/**
 * Send USDC on Tempo to bootstrap a new service wallet.
 *
 * Only needed for MPP **session** services — the seller pays close gas per
 * channel (~0.002 USDC), so a fresh wallet needs a small float.
 * Charge-based services never need prefunding (buyer pays all gas).
 *
 * Uses `feeToken: USDC` via `tempoChain` so no native token is required on
 * the source wallet either.
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
	/** Protocol tag. Default: `"mpp"`. */
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
