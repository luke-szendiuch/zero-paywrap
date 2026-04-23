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
	/** Token address in escrow; defaults to USDC on Tempo. */
	token?: Address;
};

/**
 * Seed a ChannelStore with a fake-already-open channel. Tests only —
 * production opens channels via an on-chain `open` tx.
 *
 * mppx's voucher handler treats the cached state as authoritative for
 * `channelStateTtl` ms. Pair this with `createPaywrapMpp({ ..., channelStateTtl:
 * Number.POSITIVE_INFINITY })` so tests never reach for the RPC.
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

/**
 * Restore handle returned by `stubVerifyCredential`. Always call `restore()`
 * in an `afterEach`/`finally` — leaving the stub installed across tests
 * leaks between test files running in the same process.
 */
export type StubVerifyHandle = {
	/** Restore the original `verifyCredential` implementation. */
	restore: () => void;
};

/**
 * Replace `mppx.verifyCredential` with a loose stub that:
 *   - validates the credential parses (and therefore carries a signed
 *     challenge whose HMAC id mppx bound at mint-time),
 *   - enforces the `scope` option when passed (same foot-gun guard as
 *     the real verify), and
 *   - SKIPS on-chain settlement (the only step that needs a real Tempo RPC).
 *
 * Return value imitates mppx's real verify return shape closely enough for
 * `verifyWithScope` to treat the credential as authenticated.
 *
 * !!! TESTING ONLY !!!
 *
 * Do NOT ship this anywhere near a production server — it turns a paid
 * charge into free. It's exported from `@zerorun/paywrap/testing` so it's
 * obvious when you're crossing the line, and the Workers export map
 * excludes this subpath on purpose.
 *
 * Pair with `buildChargeCredential` from `@zerorun/paywrap/signing` for the
 * 402 → sign → 200 integration-test loop:
 *
 * ```ts
 * import { buildChargeCredential } from '@zerorun/paywrap/signing';
 * import { stubVerifyCredential } from '@zerorun/paywrap/testing';
 *
 * const { restore } = stubVerifyCredential(mpp.mppx);
 * try {
 *   const authz = await buildChargeCredential({ payer, amountMicro: 20_000n, ... });
 *   const res = await app.request('/v1/joke', {
 *     method: 'POST',
 *     headers: { authorization: authz },
 *   });
 *   expect(res.status).toBe(200);
 * } finally {
 *   restore();
 * }
 * ```
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
		// The real verify parses the credential — callers already pass a
		// parsed Credential (via `extractCredential`), but we still want a
		// smoke test that the payload is present.
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
