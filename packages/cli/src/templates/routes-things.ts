import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Emit `src/routes/things.ts` — the paid/authed resource.
 *
 * Two disjoint shapes by intent:
 *
 *   - **session**: POST opens a channel + verifies voucher, GET/DELETE via
 *     proof credential, /extend top-ups the channel. Needs a per-resource
 *     state row (channel id, cumulative voucher amount) — the scaffold
 *     assumes the storage+models templates were also emitted.
 *
 *   - **charge** (stateless): POST is a one-shot paid call that settles
 *     immediately. No channel, no DB. The upstream provider is the source
 *     of truth — we list/get/delete by querying it. Idempotency comes
 *     from either buyer-chosen external naming or a credential-derived
 *     fingerprint stored in the provider's metadata. Matches the
 *     zero-netlify-integration reference pattern.
 */
export const routesThingsTemplate = (config: ScaffoldConfig): string =>
	config.intent === "session" ? sessionRoutes(config) : chargeRoutes(config);

const sessionRoutes = (config: ScaffoldConfig): string => {
	const priceMicro = Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000;
	return `import { extractCredential, sendProofChallenge, sendSessionChallenge } from "@zerorun/paywrap-adapter-fastify";
import { payerFromCredential } from "@zerorun/paywrap/auth";
import { verifyWithScope } from "@zerorun/paywrap/mpp";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { formatUnits, type Hex } from "viem";
import { z } from "zod";

const SCOPE = "${config.scope}" as const;
const PRICE_USDC_MICRO = ${priceMicro}n;

const sendPaidChallenge = (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => {
\tconst human = formatUnits(PRICE_USDC_MICRO, 6);
\treturn sendSessionChallenge(app, reply, {
\t\tamount: human,
\t\tsuggestedDeposit: human,
\t\tunitType: "request",
\t\tscope: SCOPE,
\t\tdetail,
\t});
};

const sendProof = (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => sendProofChallenge(app, reply, SCOPE, detail);

export const thingRoutes: FastifyPluginAsyncZod = async (app) => {
\t// POST / — paid route. Verifies the mppx voucher, extracts payer address
\t// from the verified channel state, then creates the resource.
\tapp.post("/", async (req, reply) => {
\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\tconst credential = extractCredential(header);
\t\tif (!credential) return sendPaidChallenge(app, reply, "payment_required");

\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\ttry {
\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t} catch (err) {
\t\t\treturn sendPaidChallenge(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t}

\t\tconst payer = await payerFromCredential(app.ctx.channelStore, verified);
\t\tif (!payer) return reply.status(500).send({ error: "channel_state_missing_after_verify" });

\t\t// TODO: implement — create your resource here, persist it, return the id.
\t\tconst id = \`thing_\${Date.now()}\`;
\t\tconst _ignored: Hex = payer;
\t\treturn reply.status(202).send({ id, status: "provisioning", payer });
\t});

\t// GET /:id — wallet-scoped read. 402 proof challenge if no credential;
\t// 404 on wallet mismatch so we don't leak existence.
\tapp.get<{ Params: { id: string } }>(
\t\t"/:id",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return sendProof(app, reply, "auth_required");
\t\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\t\ttry {
\t\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t\t} catch (err) {
\t\t\t\treturn sendProof(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, verified);
\t\t\tif (!wallet) return sendProof(app, reply, "auth_required");

\t\t\t// TODO: implement — look up resource by id, verify ownership, return it.
\t\t\treturn reply.send({ id: req.params.id, owner: wallet });
\t\t},
\t);

\t// DELETE /:id — same auth model as GET.
\tapp.delete<{ Params: { id: string } }>(
\t\t"/:id",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return sendProof(app, reply, "auth_required");
\t\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\t\ttry {
\t\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t\t} catch (err) {
\t\t\t\treturn sendProof(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, verified);
\t\t\tif (!wallet) return sendProof(app, reply, "auth_required");

\t\t\t// TODO: implement — delete resource, enforce ownership.
\t\t\treturn reply.status(204).send();
\t\t},
\t);

\t// POST /:id/extend — renew a session with a higher cumulative voucher.
\tapp.post<{ Params: { id: string } }>(
\t\t"/:id/extend",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return sendPaidChallenge(app, reply, "payment_required");
\t\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\t\ttry {
\t\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t\t} catch (err) {
\t\t\t\treturn sendPaidChallenge(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t\t}
\t\t\tconst payer = await payerFromCredential(app.ctx.channelStore, verified);
\t\t\tif (!payer) return reply.status(500).send({ error: "channel_state_missing_after_verify" });

\t\t\t// TODO: implement — verify the voucher advances by >= PRICE_USDC_MICRO
\t\t\t//   above this provision's previously-charged amount (see
\t\t\t//   zero-redis-integration provision.ts#extend for the pattern),
\t\t\t//   then bump expiresAt.
\t\t\treturn reply.send({ id: req.params.id, status: "extended", payer });
\t\t},
\t);
};
`;
};

const chargeRoutes = (config: ScaffoldConfig): string => {
	const priceMicro = Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000;
	return `import { createHash } from "node:crypto";
import { extractCredential, sendChargeChallenge, sendProofChallenge } from "@zerorun/paywrap-adapter-fastify";
import { payerFromCredential } from "@zerorun/paywrap/auth";
import { verifyWithScope } from "@zerorun/paywrap/mpp";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { formatUnits } from "viem";
import { z } from "zod";
import { resourceClient, type Resource } from "../services/thing-client.js";

const SCOPE = "${config.scope}" as const;
const PRICE_USDC_MICRO = ${priceMicro}n;

/**
 * Fingerprint a \`Payment <...>\` header into a compact hex id. Used as the
 * idempotency key stored in the upstream provider's metadata — a retry with
 * the same credential returns the existing resource without re-charging.
 */
const fingerprintCredential = (header: string): string => {
\tconst normalized = header.startsWith("Payment ") ? header : \`Payment \${header}\`;
\treturn createHash("sha256").update(normalized).digest("hex").slice(0, 24);
};

const sendPaid = (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) =>
\tsendChargeChallenge(app, reply, {
\t\tamount: formatUnits(PRICE_USDC_MICRO, 6),
\t\tscope: SCOPE,
\t\tdetail,
\t});

const sendProof = (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => sendProofChallenge(app, reply, SCOPE, detail);

export const thingRoutes: FastifyPluginAsyncZod = async (app) => {
\t/**
\t * POST / — stateless paid creation.
\t *
\t * Order of operations (critical for no-charge-on-bad-request):
\t *   1. Parse + validate the request body (400s before any verify).
\t *   2. Pre-check the upstream provider for an existing resource with a
\t *      matching chargeHash — idempotent retry returns it immediately,
\t *      no re-charge.
\t *   3. Verify credential. mppx settles the charge atomically — throws
\t *      means payer is NOT charged.
\t *   4. Create the resource upstream, stamping our metadata (payer,
\t *      chargeHash, expiresAt).
\t *   5. Return 202 + poll URL.
\t */
\tapp.post("/", async (req, reply) => {
\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\tconst credential = extractCredential(header);
\t\tif (!credential || !header) return sendPaid(app, reply, "payment_required");

\t\t// TODO: parse req.body and return 400 on invalid input BEFORE verify.
\t\tconst chargeHash = fingerprintCredential(header);

\t\t// Pre-check upstream for an existing resource with this chargeHash.
\t\t// Retry returns the existing one without re-charging.
\t\tconst existing = await app.ctx.resourceClient
\t\t\t.findByChargeHash(chargeHash)
\t\t\t.catch(() => null);
\t\tif (existing) {
\t\t\treturn reply.status(202).send({
\t\t\t\tid: existing.id,
\t\t\t\tstate: "deploying" as const,
\t\t\t\tpollUrl: \`\${app.ctx.env.PUBLIC_BASE_URL}/v1/things/\${existing.id}\`,
\t\t\t});
\t\t}

\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\ttry {
\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t} catch (err) {
\t\t\treturn sendPaid(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t}

\t\tconst payerAddress = await payerFromCredential(app.ctx.channelStore, verified);
\t\tif (!payerAddress) return reply.status(500).send({ error: "payer_extract_failed_after_verify" });

\t\t// Create upstream resource. If this throws AFTER verify settled, the
\t\t// charge is consumed — log prominently; your reaper picks up orphans.
\t\tlet resource: Resource;
\t\ttry {
\t\t\tresource = await app.ctx.resourceClient.create({
\t\t\t\tpayerAddress: payerAddress.toLowerCase(),
\t\t\t\tchargeHash,
\t\t\t\texpiresAt: Math.floor(Date.now() / 1000) + ${config.durationSeconds},
\t\t\t});
\t\t} catch (err) {
\t\t\tconst reason = err instanceof Error ? err.message : String(err);
\t\t\treq.log.error({ chargeHash, reason }, "post_settle_create_failed_refund_needed");
\t\t\treturn reply.status(500).send({ error: "create_failed", reason });
\t\t}

\t\treturn reply.status(202).send({
\t\t\tid: resource.id,
\t\t\tstate: "deploying" as const,
\t\t\tpollUrl: \`\${app.ctx.env.PUBLIC_BASE_URL}/v1/things/\${resource.id}\`,
\t\t});
\t});

\t// GET /:id — wallet-scoped read. 404 on wallet mismatch so we don't leak
\t// existence.
\tapp.get<{ Params: { id: string } }>(
\t\t"/:id",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return sendProof(app, reply, "auth_required");
\t\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\t\ttry {
\t\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t\t} catch (err) {
\t\t\t\treturn sendProof(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, verified);
\t\t\tif (!wallet) return sendProof(app, reply, "auth_required");

\t\t\tconst resource = await app.ctx.resourceClient.get(req.params.id).catch(() => null);
\t\t\tif (!resource || resource.payerAddress.toLowerCase() !== wallet.toLowerCase()) {
\t\t\t\treturn reply.status(404).send({ error: "not_found" });
\t\t\t}
\t\t\treturn reply.send(resource);
\t\t},
\t);

\t// DELETE /:id — wallet-scoped teardown.
\tapp.delete<{ Params: { id: string } }>(
\t\t"/:id",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return sendProof(app, reply, "auth_required");
\t\t\tlet verified: Awaited<ReturnType<typeof verifyWithScope>>;
\t\t\ttry {
\t\t\t\tverified = await verifyWithScope(app.ctx.mppx, credential, SCOPE);
\t\t\t} catch (err) {
\t\t\t\treturn sendProof(app, reply, err instanceof Error ? err.message : "verify_failed");
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, verified);
\t\t\tif (!wallet) return sendProof(app, reply, "auth_required");

\t\t\tconst resource = await app.ctx.resourceClient.get(req.params.id).catch(() => null);
\t\t\tif (!resource || resource.payerAddress.toLowerCase() !== wallet.toLowerCase()) {
\t\t\t\treturn reply.status(404).send({ error: "not_found" });
\t\t\t}
\t\t\tawait app.ctx.resourceClient.delete(req.params.id);
\t\t\treturn reply.status(204).send();
\t\t},
\t);
};
`;
};
