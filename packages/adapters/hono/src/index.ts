/**
 * Hono adapter for `@zerorun/paywrap`. Public barrel — re-exports only.
 * See individual modules:
 *
 *   - `./challenges` — `sendSessionChallenge`, `sendChargeChallenge`,
 *     `sendProofChallenge`, `extractCredential`.
 *   - `./gated`      — `mppGated` middleware + `PaywrapVariables` binding.
 *   - `./app`        — `createHonoApp`, `AppContextBase`, `PaywrapBindings`.
 */

export * from "./challenges.js";
export * from "./gated.js";
export * from "./app.js";
