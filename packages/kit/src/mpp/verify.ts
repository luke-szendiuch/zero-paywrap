import { type RawCredential, VERIFIED, type VerifiedCredential } from "../auth/index.js";
import type { MppxInstance } from "./mppx.js";

/**
 * Scope-checked wrapper around `mppx.verifyCredential`. The bare call with no
 * `{scope}` still verifies signature + HMAC but does NOT enforce that the
 * credential's scope matches the route's expected scope — a credential minted
 * for `read-only` would otherwise authenticate a `paid-write` POST.
 *
 * The returned `VerifiedCredential` is branded: only this function produces
 * the symbol, so TypeScript rejects callers that hand a raw credential to
 * `payerFromCredential` (or any other downstream helper).
 */
export const verifyWithScope = async (
	mppx: MppxInstance,
	credential: RawCredential,
	scope: string,
): Promise<VerifiedCredential> => {
	await mppx.verifyCredential(credential, { scope });
	return { [VERIFIED]: true, credential } as VerifiedCredential;
};

/**
 * Guard that a voucher's new cumulative advances by at least `minDelta` past
 * the cumulative already credited. mppx's own verify checks monotonicity
 * against on-chain state + the signed envelope — it does NOT know how much
 * we've already consumed for a given resource (that ledger lives in the
 * service's DB). Without this check, a client could replay the original
 * POST's voucher against `/extend` forever without paying more.
 */
export const assertVoucherAdvances = (
	currentCumulative: bigint,
	newCumulative: bigint,
	minDelta: bigint,
): void => {
	if (newCumulative < currentCumulative + minDelta) {
		throw new Error("voucher_non_advancing");
	}
};
