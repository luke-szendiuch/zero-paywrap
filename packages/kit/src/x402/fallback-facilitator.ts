import type { FacilitatorClient } from "@x402/core/server";
import type {
	PaymentPayload,
	PaymentRequirements,
	SettleResponse,
	SupportedResponse,
	VerifyResponse,
} from "@x402/core/types";

/**
 * `FacilitatorClient` that wraps an ordered list of clients and falls back
 * down the chain when a primary fails.
 *
 * Why: a single facilitator outage stops every paid route — buyers can sign
 * fine, but settlement returns `success: false`. Two real cases motivated
 * this: payai's `/settle` returned `batch_send_failed` for ~24h; x402.org's
 * facilitator silently doesn't support Base mainnet at all. An ordered list
 * with automatic failover lets a service ride out either.
 *
 * Failure semantics:
 * - `verify`: only retries on **thrown errors** (network/5xx). A facilitator
 *   that returns `isValid: false` is making a deliberate judgment about the
 *   buyer's signature; retrying would just confirm the same answer with
 *   extra latency.
 * - `settle`: retries on both **thrown errors** AND `success: false`. The
 *   payai outage looked like the latter — a structured error response, not
 *   an exception. We trade some latency on real rejections (insufficient
 *   funds, expired auth) for resilience to facilitator-side bugs.
 * - `getSupported`: unions across every client that responds. A client that
 *   throws is dropped from the union, not the whole call.
 */
export class FallbackFacilitatorClient implements FacilitatorClient {
	readonly clients: readonly FacilitatorClient[];

	constructor(clients: readonly FacilitatorClient[]) {
		if (clients.length === 0) {
			throw new Error("FallbackFacilitatorClient requires at least one client");
		}
		this.clients = clients;
	}

	async verify(
		paymentPayload: PaymentPayload,
		paymentRequirements: PaymentRequirements,
	): Promise<VerifyResponse> {
		let lastError: unknown;
		for (const client of this.clients) {
			try {
				return await client.verify(paymentPayload, paymentRequirements);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("All facilitators failed /verify");
	}

	async settle(
		paymentPayload: PaymentPayload,
		paymentRequirements: PaymentRequirements,
	): Promise<SettleResponse> {
		let lastError: unknown;
		let lastFailure: SettleResponse | undefined;
		for (const client of this.clients) {
			try {
				const result = await client.settle(paymentPayload, paymentRequirements);
				if (result.success) return result;
				lastFailure = result;
			} catch (error) {
				lastError = error;
			}
		}
		if (lastFailure) return lastFailure;
		throw lastError ?? new Error("All facilitators failed /settle");
	}

	async getSupported(): Promise<SupportedResponse> {
		const responses: SupportedResponse[] = [];
		let lastError: unknown;
		for (const client of this.clients) {
			try {
				responses.push(await client.getSupported());
			} catch (error) {
				lastError = error;
			}
		}
		if (responses.length === 0) {
			throw lastError ?? new Error("All facilitators failed /supported");
		}
		// Union kinds by (x402Version, network, scheme); first writer wins so
		// the primary's `extra` payload (e.g. facilitatorAddress) is preserved.
		const kindKey = (k: SupportedResponse["kinds"][number]) =>
			`${k.x402Version}|${k.network}|${k.scheme}`;
		const kinds: SupportedResponse["kinds"] = [];
		const seenKinds = new Set<string>();
		for (const r of responses) {
			for (const k of r.kinds) {
				const key = kindKey(k);
				if (seenKinds.has(key)) continue;
				seenKinds.add(key);
				kinds.push(k);
			}
		}
		const extensions = Array.from(new Set(responses.flatMap((r) => r.extensions ?? [])));
		const signers: Record<string, string[]> = {};
		for (const r of responses) {
			for (const [network, addrs] of Object.entries(r.signers ?? {}) as Array<[string, string[]]>) {
				const merged = new Set([...(signers[network] ?? []), ...addrs]);
				signers[network] = Array.from(merged);
			}
		}
		return { kinds, extensions, signers };
	}
}
