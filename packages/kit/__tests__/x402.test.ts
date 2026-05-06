import { describe, expect, it } from "vitest";
import {
	BASE_NETWORK,
	BASE_SEPOLIA_NETWORK,
	BASE_SEPOLIA_USDC,
	BASE_USDC,
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

	it("defaults to payai facilitator on base mainnet", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base" });
		// HTTPFacilitatorClient stores the resolved URL on `.url` (trailing
		// slashes stripped). x402.org is testnet-only, so mainnet must not
		// fall through to that default.
		expect((x402.facilitator as unknown as { url: string }).url).toBe(
			"https://facilitator.payai.network",
		);
	});

	it("defaults to x402.org facilitator on base-sepolia", () => {
		const x402 = createPaywrapX402({ payTo: PAY_TO, network: "base-sepolia" });
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
});
