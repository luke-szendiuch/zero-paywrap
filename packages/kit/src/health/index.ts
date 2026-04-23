/**
 * Generic health-check aggregator. Services call this from their `/healthz`
 * route to produce a response that any PaaS (Render, Fly, k8s) can consume.
 *
 * Contract:
 *   - 200 when every probe resolves to `"up"` (or the string `"up"`).
 *   - 503 when any probe reports anything else (including throws).
 *   - Body shape is stable: `{ ok, probes: Record<name, "up"|"down"|string> }`,
 *     optionally augmented with arbitrary `extras` (wallet address, version,
 *     etc.) the service wants to expose.
 *
 * Kit is framework-agnostic — the service binds this to its router:
 *
 *   app.get('/healthz', async (_req, reply) => {
 *     const { status, body } = await aggregateHealthProbes({
 *       probes: { db: dbPing, redis: redisPing },
 *       extras: { wallet: walletAddress },
 *     });
 *     reply.status(status).send(body);
 *   });
 */
export type ProbeResult = "up" | "down" | string;
export type Probe = () => Promise<ProbeResult> | ProbeResult;

export type AggregateHealthProbesInput = {
	probes: Record<string, Probe>;
	/** Arbitrary static fields to include in the body (e.g. wallet, version). */
	extras?: Record<string, string | number | boolean>;
};

export type AggregateHealthProbesResult = {
	status: 200 | 503;
	body: {
		ok: boolean;
		probes: Record<string, ProbeResult>;
	} & Record<string, unknown>;
};

export const aggregateHealthProbes = async (
	input: AggregateHealthProbesInput,
): Promise<AggregateHealthProbesResult> => {
	const entries = await Promise.all(
		Object.entries(input.probes).map(async ([name, probe]) => {
			try {
				const result = await probe();
				return [name, result] as const;
			} catch {
				return [name, "down"] as const;
			}
		}),
	);

	const probes: Record<string, ProbeResult> = {};
	let ok = true;
	for (const [name, result] of entries) {
		probes[name] = result;
		if (result !== "up") ok = false;
	}

	return {
		status: ok ? 200 : 503,
		body: { ok, probes, ...(input.extras ?? {}) },
	};
};
