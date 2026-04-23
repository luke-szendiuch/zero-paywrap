import type { VerifiedCredential } from "../auth/index.js";
import type { MppxInstance } from "./mppx.js";

/**
 * Thin wrapper around `mppx.verifyCredential(credential, { scope })` that
 * forces callers to pass `scope` at the callsite. This closes a foot-gun:
 * `mppx.verifyCredential(credential)` with no options still verifies the
 * signature + HMAC, but does NOT enforce that the scope on the credential
 * matches the scope this route expects. A credential minted for
 * `scope="read-only"` would otherwise authenticate a POST that guards
 * `scope="paid-write"`.
 *
 * Returns the verified credential on success; lets mppx's error bubble on
 * failure (same semantics as the underlying call, different signature).
 */
export const verifyWithScope = async (
	mppx: MppxInstance,
	credential: unknown,
	scope: string,
): Promise<VerifiedCredential> => {
	return (await mppx.verifyCredential(credential, { scope })) as VerifiedCredential;
};

/**
 * Guard that a voucher's new cumulative amount advances by at least
 * `minDelta` above the current cumulative we've already credited for this
 * provision.
 *
 * mppx's own `verifyCredential` checks monotonicity vs. the on-chain
 * channel state + signed envelope — it knows the voucher advances the
 * channel, but it does NOT know how much of that cumulative we've already
 * consumed for a given resource. That ledger lives in the service's own
 * DB row (`voucher_cumulative_amount`). Without this check, a client could
 * replay the original POST's voucher against `/extend` and keep extending
 * forever without paying more.
 *
 * Throws `Error("voucher_non_advancing")` on failure so routes can catch
 * a stable error code; no custom error class — keep it stringly-typed and
 * boring.
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
