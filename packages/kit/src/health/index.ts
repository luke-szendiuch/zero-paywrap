/**
 * Health-check aggregator. 200 when every probe resolves to `"up"`, 503 else
 * (including throws). Body: `{ok, probes, ...extras}`. Framework-agnostic —
 * bind to your router: `app.get('/healthz', async () => aggregateHealthProbes(...))`.
 */
export type ProbeResult = "up" | "down" | string;
export type Probe = () => Promise<ProbeResult> | ProbeResult;

export type AggregateHealthProbesInput = {
	probes: Record<string, Probe>;
	/** Static fields to include in the body (e.g. wallet, version). */
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
				return [name, await probe()] as const;
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
