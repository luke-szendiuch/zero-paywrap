import type { FacilitatorClient } from "@x402/core/server";
import type {
	PaymentPayload,
	PaymentRequirements,
	SettleResponse,
	SupportedResponse,
	VerifyResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
	BASE_NETWORK,
	BASE_SEPOLIA_NETWORK,
	BASE_SEPOLIA_USDC,
	BASE_USDC,
	FallbackFacilitatorClient,
	createPaywrapX402,
	x402NetworkId,
	x402UsdcAsset,
} from "../src/x402/index.js";

const PAY_TO = "0x9CC42f3d9245B867ACccd630B43f906c1665b176" as const;

describe("x402 constants", () => {
	it("maps networks to CAIP-2 ids", () => {
		expect(x402NetworkId("base")).toBe(BASE_NETWORK);
		expect(x402NetworkId("base-sepolia")).toBe(BASE_SEPOLIA_NETWORK);
	});

	it("maps networks to USDC contract addresses", () => {
		expect(x402UsdcAsset("base")).toBe(BASE_USDC);
		expect(x402UsdcAsset("base-sepolia")).toBe(BASE_SEPOLIA_USDC);
	});
});

describe("createPaywrapX402", () => {
	it("returns a configured resource server with payTo + network", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base" });
		expect(x402.payTo).toBe(PAY_TO);
		expect(x402.network).toBe("base");
		expect(x402.networkId).toBe(BASE_NETWORK);
		expect(x402.resourceServer).toBeDefined();
		expect(x402.facilitator).toBeDefined();
		expect(typeof x402.facilitator.verify).toBe("function");
		expect(typeof x402.facilitator.settle).toBe("function");
	});

	it("respects base-sepolia network selection", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base-sepolia" });
		expect(x402.networkId).toBe(BASE_SEPOLIA_NETWORK);
	});

	it("defaults to a [world.fun, payai] fallback chain on base mainnet", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base" });
		// Mainnet must fan out across two open facilitators so a single
		// outage doesn't kill paid routes (payai's /settle was down for ~24h
		// in May 2026 — that's the failure mode this default protects against).
		expect(x402.facilitator).toBeInstanceOf(FallbackFacilitatorClient);
		const urls = (x402.facilitator as FallbackFacilitatorClient).clients.map(
			(c) => (c as unknown as { url: string }).url,
		);
		expect(urls).toEqual(["https://facilitator.world.fun", "https://facilitator.payai.network"]);
	});

	it("defaults to x402.org facilitator on base-sepolia (single-client, no fallback)", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base-sepolia" });
		expect(x402.facilitator).not.toBeInstanceOf(FallbackFacilitatorClient);
		expect((x402.facilitator as unknown as { url: string }).url).toBe(
			"https://x402.org/facilitator",
		);
	});

	it("uses an explicit facilitator url when provided", () => {
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base",
			facilitator: { url: "https://custom.example/" },
		});
		expect(x402.facilitator).not.toBeInstanceOf(FallbackFacilitatorClient);
		expect((x402.facilitator as unknown as { url: string }).url).toBe("https://custom.example");
	});

	it("accepts a custom facilitator client", () => {
		const stub = {
			verify: async () => ({}) as never,
			settle: async () => ({}) as never,
			getSupported: async () => ({ kinds: [] }) as never,
		};
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base",
			facilitator: stub,
		});
		expect(x402.facilitator).toBe(stub);
	});

	it("wraps an array of facilitator entries in a FallbackFacilitatorClient", () => {
		const x402 = createPaywrapX402({
			payTo: PAY_TO,
			network: "base",
			facilitator: [{ url: "https://a.example/" }, { url: "https://b.example/" }],
		});
		expect(x402.facilitator).toBeInstanceOf(FallbackFacilitatorClient);
		const urls = (x402.facilitator as FallbackFacilitatorClient).clients.map(
			(c) => (c as unknown as { url: string }).url,
		);
		expect(urls).toEqual(["https://a.example", "https://b.example"]);
	});
});

// Minimal in-memory facilitator stub for fallback tests. Each method records
// invocations so we can assert the fallback only escalates when needed.
type StubBehavior = {
	verify?: VerifyResponse | Error;
	settle?: SettleResponse | Error;
	supported?: SupportedResponse | Error;
};

class StubFacilitator implements FacilitatorClient {
	calls = { verify: 0, settle: 0, getSupported: 0 };
	constructor(private behavior: StubBehavior) {}
	async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
		this.calls.verify++;
		const b = this.behavior.verify;
		if (b === undefined) throw new Error("StubFacilitator.verify not configured");
		if (b instanceof Error) throw b;
		return b;
	}
	async settle(_p: PaymentPayload, _r: PaymentRequirements): Promise<SettleResponse> {
		this.calls.settle++;
		const b = this.behavior.settle;
		if (b === undefined) throw new Error("StubFacilitator.settle not configured");
		if (b instanceof Error) throw b;
		return b;
	}
	async getSupported(): Promise<SupportedResponse> {
		this.calls.getSupported++;
		const b = this.behavior.supported;
		if (b === undefined) throw new Error("StubFacilitator.getSupported not configured");
		if (b instanceof Error) throw b;
		return b;
	}
}

const PAYLOAD = {} as PaymentPayload;
const REQS = {} as PaymentRequirements;

describe("FallbackFacilitatorClient", () => {
	it("rejects empty client list at construction time", () => {
		expect(() => new FallbackFacilitatorClient([])).toThrow();
	});

	describe("settle", () => {
		it("returns the primary's success without touching the backup", async () => {
			const ok = { success: true, transaction: "0xabc", network: "base", payer: "0x1" };
			const primary = new StubFacilitator({ settle: ok as SettleResponse });
			const backup = new StubFacilitator({});
			const fb = new FallbackFacilitatorClient([primary, backup]);
			expect(await fb.settle(PAYLOAD, REQS)).toEqual(ok);
			expect(primary.calls.settle).toBe(1);
			expect(backup.calls.settle).toBe(0);
		});

		it("falls through to backup when primary throws", async () => {
			const ok = { success: true, transaction: "0xabc", network: "base", payer: "0x1" };
			const primary = new StubFacilitator({ settle: new Error("network down") });
			const backup = new StubFacilitator({ settle: ok as SettleResponse });
			const fb = new FallbackFacilitatorClient([primary, backup]);
			expect(await fb.settle(PAYLOAD, REQS)).toEqual(ok);
			expect(primary.calls.settle).toBe(1);
			expect(backup.calls.settle).toBe(1);
		});

		it("falls through when primary returns success:false (the payai outage shape)", async () => {
			const fail = {
				success: false,
				transaction: "",
				network: "base",
				payer: "0x1",
				errorReason: "batch_send_failed",
			} as SettleResponse;
			const ok = { success: true, transaction: "0xabc", network: "base", payer: "0x1" };
			const primary = new StubFacilitator({ settle: fail });
			const backup = new StubFacilitator({ settle: ok as SettleResponse });
			const fb = new FallbackFacilitatorClient([primary, backup]);
			expect(await fb.settle(PAYLOAD, REQS)).toEqual(ok);
			expect(primary.calls.settle).toBe(1);
			expect(backup.calls.settle).toBe(1);
		});

		it("returns the last failure body when all clients return success:false", async () => {
			const failA = {
				success: false,
				transaction: "",
				network: "base",
				payer: "0x1",
			} as SettleResponse;
			const failB = {
				success: false,
				transaction: "",
				network: "base",
				payer: "0x2",
			} as SettleResponse;
			const fb = new FallbackFacilitatorClient([
				new StubFacilitator({ settle: failA }),
				new StubFacilitator({ settle: failB }),
			]);
			expect(await fb.settle(PAYLOAD, REQS)).toEqual(failB);
		});

		it("rethrows the last error when all clients throw", async () => {
			const fb = new FallbackFacilitatorClient([
				new StubFacilitator({ settle: new Error("first") }),
				new StubFacilitator({ settle: new Error("second") }),
			]);
			await expect(fb.settle(PAYLOAD, REQS)).rejects.toThrow("second");
		});
	});

	describe("verify", () => {
		it("returns isValid:false from primary without consulting backup", async () => {
			// A deliberate `isValid: false` is authoritative — retrying just
			// burns latency on a payment that's actually invalid.
			const invalid = { isValid: false, invalidReason: "expired" } as VerifyResponse;
			const primary = new StubFacilitator({ verify: invalid });
			const backup = new StubFacilitator({});
			const fb = new FallbackFacilitatorClient([primary, backup]);
			expect(await fb.verify(PAYLOAD, REQS)).toEqual(invalid);
			expect(backup.calls.verify).toBe(0);
		});

		it("falls through on thrown errors", async () => {
			const ok = { isValid: true, payer: "0x1" } as VerifyResponse;
			const primary = new StubFacilitator({ verify: new Error("502") });
			const backup = new StubFacilitator({ verify: ok });
			const fb = new FallbackFacilitatorClient([primary, backup]);
			expect(await fb.verify(PAYLOAD, REQS)).toEqual(ok);
		});
	});

	describe("getSupported", () => {
		it("unions kinds, extensions, and signers across responding clients", async () => {
			const a: SupportedResponse = {
				kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
				extensions: ["bazaar"],
				signers: { "eip155:*": ["0xa"] },
			};
			const b: SupportedResponse = {
				kinds: [
					{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, // dup, dropped
					{ x402Version: 2, scheme: "exact", network: "eip155:1" },
				],
				extensions: ["bazaar", "eip2612GasSponsoring"],
				signers: { "eip155:*": ["0xb"] },
			};
			const fb = new FallbackFacilitatorClient([
				new StubFacilitator({ supported: a }),
				new StubFacilitator({ supported: b }),
			]);
			const merged = await fb.getSupported();
			expect(merged.kinds).toHaveLength(2);
			expect(merged.kinds.map((k) => k.network)).toEqual(["eip155:8453", "eip155:1"]);
			expect(merged.extensions.sort()).toEqual(["bazaar", "eip2612GasSponsoring"]);
			expect(merged.signers["eip155:*"]?.sort()).toEqual(["0xa", "0xb"]);
		});

		it("skips clients that throw and returns the union of the rest", async () => {
			const a: SupportedResponse = {
				kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
				extensions: [],
				signers: {},
			};
			const fb = new FallbackFacilitatorClient([
				new StubFacilitator({ supported: new Error("down") }),
				new StubFacilitator({ supported: a }),
			]);
			const merged = await fb.getSupported();
			expect(merged.kinds).toHaveLength(1);
		});

		it("rethrows when every client fails", async () => {
			const fb = new FallbackFacilitatorClient([
				new StubFacilitator({ supported: new Error("a-down") }),
				new StubFacilitator({ supported: new Error("b-down") }),
			]);
			await expect(fb.getSupported()).rejects.toThrow("b-down");
		});
	});
});
