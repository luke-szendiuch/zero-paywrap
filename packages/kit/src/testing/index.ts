import type { Session } from "mppx/tempo";
import type { Address, Hex } from "viem";
import { TEMPO_USDC } from "../mpp/constants.js";
import type { MppxInstance } from "../mpp/mppx.js";

export type SeedChannelParams = {
	channelStore: ReturnType<typeof Session.ChannelStore.fromStore>;
	channelId: Hex;
	payer: Address;
	payee: Address;
	escrowContract: Address;
	chainId: number;
	deposit: bigint;
	token?: Address;
};

/**
 * Seed a ChannelStore with a fake-already-open channel. Tests only.
 *
 * mppx's voucher handler treats cached state as authoritative for
 * `channelStateTtl` ms. Pair with `createPaywrapMpp({ ..., channelStateTtl:
 * Number.POSITIVE_INFINITY })` so tests never hit the RPC.
 */
export const seedChannel = async (params: SeedChannelParams): Promise<void> => {
	await params.channelStore.updateChannel(params.channelId, () => ({
		channelId: params.channelId,
		chainId: params.chainId,
		escrowContract: params.escrowContract,
		closeRequestedAt: 0n,
		createdAt: new Date().toISOString(),
		deposit: params.deposit,
		finalized: false,
		highestVoucher: null,
		highestVoucherAmount: 0n,
		payee: params.payee,
		payer: params.payer,
		settledOnChain: 0n,
		spent: 0n,
		token: params.token ?? TEMPO_USDC,
		units: 0,
		authorizedSigner: params.payer,
	}));
};

export type StubVerifyHandle = {
	restore: () => void;
};

/**
 * Replace `mppx.verifyCredential` with a stub that parses the credential +
 * enforces `scope` but SKIPS on-chain settlement. !!! TESTING ONLY — turns a
 * paid charge into free. Exported under `@zeroclickai/paywrap/testing` to make
 * the boundary obvious; the Workers export map excludes this subpath.
 *
 * Always call `restore()` in an `afterEach`/`finally` — a leftover stub
 * leaks into other tests in the same process.
 *
 * Pair with `buildChargeCredential` for a 402 → sign → 200 integration loop.
 */
export const stubVerifyCredential = (mppx: MppxInstance): StubVerifyHandle => {
	// biome-ignore lint/suspicious/noExplicitAny: mppx.verifyCredential has a many-argument overload; the narrow `unknown[]` type from biome breaks the replacement's shape.
	const target = mppx as { verifyCredential: (...args: any[]) => Promise<unknown> };
	const original = target.verifyCredential;
	if (typeof original !== "function") {
		throw new Error(
			"stubVerifyCredential: mppx.verifyCredential is not a function — did you pass an mppx instance?",
		);
	}
	target.verifyCredential = async (credential: unknown, options?: { scope?: string }) => {
		if (!credential || typeof credential !== "object") {
			throw new Error("stubVerifyCredential: missing credential");
		}
		const cred = credential as {
			challenge?: { opaque?: Record<string, string> };
			payload?: unknown;
		};
		if (!cred.challenge) {
			throw new Error("stubVerifyCredential: credential missing `challenge`");
		}
		if (options?.scope) {
			const onCred = cred.challenge.opaque?._mppx_scope;
			if (onCred !== options.scope) {
				throw new Error(
					`stubVerifyCredential: scope mismatch (expected "${options.scope}", got "${onCred ?? "<unset>"}")`,
				);
			}
		}
		return {
			method: "tempo",
			status: "success",
			timestamp: new Date().toISOString(),
			reference: "stubbed-in-test",
		};
	};
	return {
		restore: () => {
			target.verifyCredential = original;
		},
	};
};
