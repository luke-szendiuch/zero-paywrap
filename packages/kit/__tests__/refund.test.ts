import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { TEMPO_USDC } from "../src/mpp/constants.js";
import { refundCharge } from "../src/refund/index.js";

const PAYER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const TX_HASH: `0x${string}` = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const stubMpp = (overrides?: { sendTransaction?: ReturnType<typeof vi.fn> }) => {
	const account = privateKeyToAccount(generatePrivateKey());
	const sendTransaction = overrides?.sendTransaction ?? vi.fn().mockResolvedValue(TX_HASH);
	return {
		account,
		walletAddress: account.address,
		// biome-ignore lint/suspicious/noExplicitAny: hand-rolled stub of the viem wallet client surface refundCharge touches
		client: { sendTransaction } as any,
		sendTransaction,
	};
};

describe("refundCharge", () => {
	it("sends an ERC-20 transfer to the payer for the requested amount", async () => {
		const mpp = stubMpp();
		const sink = vi.fn();

		const result = await refundCharge(mpp, { payer: PAYER, amountUsdcMicro: 50_000n }, { sink });

		expect(result.status).toBe("sent");
		expect(result.txHash).toBe(TX_HASH);
		expect(result.amountUsdcMicro).toBe(50_000n);
		expect(mpp.sendTransaction).toHaveBeenCalledTimes(1);
		const call = mpp.sendTransaction.mock.calls[0][0];
		expect(call.to).toBe(TEMPO_USDC);
		expect(call.value).toBe(0n);
		expect(call.account).toBe(mpp.account);
		// transfer(address,uint256) selector is 0xa9059cbb
		expect(call.data.startsWith("0xa9059cbb")).toBe(true);
	});

	it("emits a paywrap_refund_sent JSON line through the sink", async () => {
		const mpp = stubMpp();
		const sink = vi.fn();

		await refundCharge(
			mpp,
			{
				payer: PAYER,
				amountUsdcMicro: 50_000n,
				note: "upstream 503 on /v1/render",
				chargeHash: "ff00",
				sku: "render:v1",
			},
			{ sink },
		);

		expect(sink).toHaveBeenCalledTimes(1);
		const event = JSON.parse(sink.mock.calls[0][0]);
		expect(event.msg).toBe("paywrap_refund_sent");
		expect(event.v).toBe(1);
		expect(event.payer).toBe(PAYER);
		expect(event.amountUsdcMicro).toBe("50000");
		expect(event.txHash).toBe(TX_HASH);
		expect(event.tokenContract).toBe(TEMPO_USDC);
		expect(event.note).toBe("upstream 503 on /v1/render");
		expect(event.chargeHash).toBe("ff00");
		expect(event.sku).toBe("render:v1");
		expect(typeof event.timestamp).toBe("string");
	});

	it("omits optional fields when not provided", async () => {
		const mpp = stubMpp();
		const sink = vi.fn();

		await refundCharge(mpp, { payer: PAYER, amountUsdcMicro: 1n }, { sink });

		const event = JSON.parse(sink.mock.calls[0][0]);
		expect(event).not.toHaveProperty("note");
		expect(event).not.toHaveProperty("chargeHash");
		expect(event).not.toHaveProperty("sku");
	});

	it("defaults the sink to console.error when none is provided", async () => {
		const mpp = stubMpp();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await refundCharge(mpp, { payer: PAYER, amountUsdcMicro: 1n });

		expect(errSpy).toHaveBeenCalledTimes(1);
		const event = JSON.parse(errSpy.mock.calls[0][0] as string);
		expect(event.msg).toBe("paywrap_refund_sent");
		errSpy.mockRestore();
	});

	it("honors a custom tokenContract", async () => {
		const mpp = stubMpp();
		const sink = vi.fn();
		const altToken: `0x${string}` = "0x2222222222222222222222222222222222222222";

		await refundCharge(
			mpp,
			{ payer: PAYER, amountUsdcMicro: 1n },
			{ tokenContract: altToken, sink },
		);

		expect(mpp.sendTransaction.mock.calls[0][0].to).toBe(altToken);
		const event = JSON.parse(sink.mock.calls[0][0]);
		expect(event.tokenContract).toBe(altToken);
	});

	it("rejects zero or negative amounts", async () => {
		const mpp = stubMpp();
		await expect(
			refundCharge(mpp, { payer: PAYER, amountUsdcMicro: 0n }, { sink: vi.fn() }),
		).rejects.toThrow(/must be > 0/);
		await expect(
			refundCharge(mpp, { payer: PAYER, amountUsdcMicro: -1n }, { sink: vi.fn() }),
		).rejects.toThrow(/must be > 0/);
		expect(mpp.sendTransaction).not.toHaveBeenCalled();
	});

	it("propagates RPC failures to the caller for retry/queue handling", async () => {
		const mpp = stubMpp({
			sendTransaction: vi.fn().mockRejectedValue(new Error("RPC unreachable")),
		});
		await expect(
			refundCharge(mpp, { payer: PAYER, amountUsdcMicro: 1n }, { sink: vi.fn() }),
		).rejects.toThrow("RPC unreachable");
	});

	it("swallows sink errors so observability cannot break the refund tx", async () => {
		const mpp = stubMpp();
		const exploding = () => {
			throw new Error("sink down");
		};
		const result = await refundCharge(
			mpp,
			{ payer: PAYER, amountUsdcMicro: 1n },
			{ sink: exploding },
		);
		expect(result.status).toBe("sent");
	});
});
