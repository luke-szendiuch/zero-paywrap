export const reaperJobTemplate =
	(): string => `import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import type { Env } from "../../core/env.js";

export type ReaperContext = { env: Env; mpp: PaywrapMpp };

/**
 * Reaper — periodic cleanup for orphaned/expired upstream resources.
 *
 * Since the charge-intent scaffold is stateless, your upstream provider is
 * the source of truth. The reaper queries it for resources whose
 * \`expiresAt\` has passed (or resources tagged with our \`managedBy\` marker
 * that have no current payer), and deletes them.
 *
 * This stub is deliberately empty — the exact query depends on your
 * provider's list/filter API. Implement by calling your provider's listing
 * endpoint, filtering on the metadata you stamped at create time, and
 * issuing deletes for anything expired.
 */
export const reaperJob = async (_ctx: ReaperContext): Promise<void> => {
\t// TODO: implement by querying your upstream provider.
\t//   1. List resources tagged with our managedBy marker.
\t//   2. Filter to those whose metadata.expiresAt is in the past.
\t//   3. Delete them via the resourceClient.
\t// See zero-netlify-integration/src/worker/jobs/site-reaper-job.ts for
\t// the reference pattern.
};
`;
