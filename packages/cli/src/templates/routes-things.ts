import type { ScaffoldConfig } from "../lib/scaffold-config.js";

/**
 * Emit `src/routes/things.ts` — the paid/authed resource. Shape varies by
 * intent: session has a POST + /extend + GET/DELETE (proof); charge has a
 * POST (paid) + GET/DELETE (proof).
 */
export const routesThingsTemplate = (config: ScaffoldConfig): string => {
	const priceMicro = Math.round(Number(config.priceUsdc) * 1_000_000) || 20_000;
	const isSession = config.intent === "session";

	const paidBuilderImport = isSession ? "buildSessionChallenge" : "buildChargeChallenge";
	return `import {
\t${paidBuilderImport},
\tbuildProofChallenge,
\tpayerFromCredential,
} from "@zerorun/paywrap/auth";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Credential } from "mppx";
import { formatUnits, type Hex } from "viem";
import { z } from "zod";

const SCOPE = "${config.scope}" as const;
const PRICE_USDC_MICRO = ${priceMicro}n;

const extractCredential = (header: string | undefined) => {
\tif (!header) return null;
\ttry {
\t\treturn Credential.deserialize(header.startsWith("Payment ") ? header : \`Payment \${header}\`);
\t} catch {
\t\treturn null;
\t}
};

${
	isSession
		? `const replyWithChallenge = async (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => {
\tconst human = formatUnits(PRICE_USDC_MICRO, 6);
\tconst challenge = await buildSessionChallenge(app.ctx.mppx, {
\t\tamount: human,
\t\tsuggestedDeposit: human,
\t\tunitType: "request",
\t\tscope: SCOPE,
\t\tdetail,
\t});
\tfor (const [k, v] of Object.entries(challenge.headers)) reply.header(k, v);
\treturn reply.status(challenge.status).send(challenge.body);
};`
		: `const replyWithChargeChallenge = async (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => {
\tconst challenge = await buildChargeChallenge(app.ctx.mppx, {
\t\tamount: formatUnits(PRICE_USDC_MICRO, 6),
\t\tscope: SCOPE,
\t\tdetail,
\t});
\tfor (const [k, v] of Object.entries(challenge.headers)) reply.header(k, v);
\treturn reply.status(challenge.status).send(challenge.body);
};`
}

const replyWithProofChallenge = async (
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\tapp: any,
\t// biome-ignore lint/suspicious/noExplicitAny: fastify app/reply generics
\treply: any,
\tdetail: string,
) => {
\tconst challenge = await buildProofChallenge(app.ctx.mppx, { scope: SCOPE, detail });
\tfor (const [k, v] of Object.entries(challenge.headers)) reply.header(k, v);
\treturn reply.status(challenge.status).send(challenge.body);
};

export const thingRoutes: FastifyPluginAsyncZod = async (app) => {
\t// POST / — paid route. Verifies the mppx voucher, extracts payer address
\t// from the channel state, then creates the resource.
\tapp.post("/", async (req, reply) => {
\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\tconst credential = extractCredential(header);
\t\tif (!credential) return ${isSession ? "replyWithChallenge" : "replyWithChargeChallenge"}(app, reply, "payment_required");
\t\ttry {
\t\t\tawait app.ctx.mppx.verifyCredential(credential, { scope: SCOPE });
\t\t} catch (err) {
\t\t\treturn ${isSession ? "replyWithChallenge" : "replyWithChargeChallenge"}(
\t\t\t\tapp,
\t\t\t\treply,
\t\t\t\terr instanceof Error ? err.message : "verify_failed",
\t\t\t);
\t\t}

\t\tconst payer = await payerFromCredential(app.ctx.channelStore, credential);
\t\tif (!payer) return reply.status(500).send({ error: "channel_state_missing_after_verify" });

\t\t// TODO: implement — create your resource here, persist it, return the id.
\t\tconst id = \`thing_\${Date.now()}\`;
\t\treturn reply.status(202).send({
\t\t\tid,
\t\t\tstatus: "provisioning",
\t\t\tpayer,
\t\t});
\t});

\t// GET /:id — wallet-scoped read. 402 proof challenge if no credential;
\t// return 404 on wallet mismatch so we don't leak existence.
\tapp.get<{ Params: { id: string } }>(
\t\t"/:id",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return replyWithProofChallenge(app, reply, "auth_required");
\t\t\ttry {
\t\t\t\tawait app.ctx.mppx.verifyCredential(credential, { scope: SCOPE });
\t\t\t} catch (err) {
\t\t\t\treturn replyWithProofChallenge(
\t\t\t\t\tapp,
\t\t\t\t\treply,
\t\t\t\t\terr instanceof Error ? err.message : "verify_failed",
\t\t\t\t);
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, credential);
\t\t\tif (!wallet) return replyWithProofChallenge(app, reply, "auth_required");

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
\t\t\tif (!credential) return replyWithProofChallenge(app, reply, "auth_required");
\t\t\ttry {
\t\t\t\tawait app.ctx.mppx.verifyCredential(credential, { scope: SCOPE });
\t\t\t} catch (err) {
\t\t\t\treturn replyWithProofChallenge(
\t\t\t\t\tapp,
\t\t\t\t\treply,
\t\t\t\t\terr instanceof Error ? err.message : "verify_failed",
\t\t\t\t);
\t\t\t}
\t\t\tconst wallet = await payerFromCredential(app.ctx.channelStore, credential);
\t\t\tif (!wallet) return replyWithProofChallenge(app, reply, "auth_required");

\t\t\t// TODO: implement — delete resource, enforce ownership.
\t\t\treturn reply.status(204).send();
\t\t},
\t);

${
	isSession
		? `\t// POST /:id/extend — renew a session with a higher cumulative voucher.
\tapp.post<{ Params: { id: string } }>(
\t\t"/:id/extend",
\t\t{ schema: { params: z.object({ id: z.string() }) } },
\t\tasync (req, reply) => {
\t\t\tconst header = (req.headers.authorization ?? req.headers.payment) as string | undefined;
\t\t\tconst credential = extractCredential(header);
\t\t\tif (!credential) return replyWithChallenge(app, reply, "payment_required");
\t\t\ttry {
\t\t\t\tawait app.ctx.mppx.verifyCredential(credential, { scope: SCOPE });
\t\t\t} catch (err) {
\t\t\t\treturn replyWithChallenge(
\t\t\t\t\tapp,
\t\t\t\t\treply,
\t\t\t\t\terr instanceof Error ? err.message : "verify_failed",
\t\t\t\t);
\t\t\t}
\t\t\tconst payer = await payerFromCredential(app.ctx.channelStore, credential);
\t\t\tif (!payer) return reply.status(500).send({ error: "channel_state_missing_after_verify" });

\t\t\t// TODO: implement — verify the voucher advances by >= PRICE_USDC_MICRO
\t\t\t//   above this provision's previously-charged amount (see zero-redis-integration
\t\t\t//   provision.ts#extend for the pattern), then bump expiresAt.
\t\t\tconst _ignored: Hex = payer;
\t\t\treturn reply.send({ id: req.params.id, status: "extended" });
\t\t},
\t);
`
		: ""
}};
`;
};
