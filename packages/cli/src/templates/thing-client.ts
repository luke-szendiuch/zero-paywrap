import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Generic typed client for the upstream provider (the source of truth for
 * your charge-intent service). Matches the shape Netlify's integration uses
 * — `create/get/list/delete/findByChargeHash` — so the route file can stay
 * stateless. Swap the implementation to call Netlify, R2, DNS, whatever
 * you're reselling.
 */
export const thingClientTemplate = (
	_config: ScaffoldConfig,
): string => `import type { Env } from "../core/env.js";

/**
 * Your upstream provider's resource, with our metadata stamped on. The
 * provider is authoritative — we don't keep a local mirror.
 */
export type Resource = {
\tid: string;
\t/** Caller's wallet in lower-case. Stored as upstream metadata. */
\tpayerAddress: string;
\t/** Credential fingerprint — idempotency key. Stored as upstream metadata. */
\tchargeHash: string;
\texpiresAt: number;
};

export type ResourceClient = {
\tcreate: (args: {
\t\tpayerAddress: string;
\t\tchargeHash: string;
\t\texpiresAt: number;
\t}) => Promise<Resource>;
\tget: (id: string) => Promise<Resource | null>;
\tlist: (filter: { payerAddress?: string }) => Promise<Resource[]>;
\tdelete: (id: string) => Promise<void>;
\t/**
\t * Look up a resource by the chargeHash we stored in upstream metadata.
\t * Used by the POST handler's pre-verify idempotency check. Return null
\t * for "no match" — do NOT throw.
\t */
\tfindByChargeHash: (chargeHash: string) => Promise<Resource | null>;
};

/**
\t * Create the client. Your implementation talks to the upstream provider
\t * (e.g. Netlify's sites API) using credentials from env. Everything the
\t * route needs — create, read, list, delete, fingerprint lookup — lives
\t * here. Compose it in \`src/app/app-context.ts\`.
\t */
export const resourceClient = (_env: Env): ResourceClient => {
\t// TODO: implement against your upstream provider. See
\t// zero-netlify-integration/src/services/netlify-client.ts for the
\t// reference pattern.
\tthrow new Error("resourceClient not implemented — wire up your upstream API here");
};
`;
