/**
 * Fastify adapter for `@zerorun/paywrap`. Public barrel — re-exports only.
 * See individual modules:
 *
 *   - `./challenges` — `sendSessionChallenge`, `sendChargeChallenge`,
 *     `sendProofChallenge`, `extractCredential`.
 *   - `./gated` — `mppGated` preHandler factory.
 *   - `./app` — `createFastifyApp`, `AppContextBase`, `mppGated` marker.
 */

export * from "./challenges.js";
export * from "./gated.js";
export * from "./app.js";
