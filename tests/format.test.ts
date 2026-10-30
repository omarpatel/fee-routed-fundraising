import { describe, expect, it } from "vitest";
import type { Delivery } from "@/lib/db/schema";
import { publicFailureReason } from "@/lib/format";
import { receiptFixture } from "./fixtures";

describe("publicFailureReason", () => {
  const raw = "Zentro 502: card 4111 declined at gateway gw-7 (token sk_live_abc)";
  const delivery = (over: Partial<Delivery>) => receiptFixture({ delivery: { failureReason: raw, ...over } }).delivery;

  it("states the failure from ledger state and never echoes the operator-only failureReason", () => {
    const beforeFunding = publicFailureReason(delivery({ status: "failed", fundingTxSig: null }));
    const afterFunding = publicFailureReason(delivery({ status: "failed", fundingTxSig: "FundSig111" }));
    const recovered = publicFailureReason(delivery({ status: "failed", fundingTxSig: "FundSig111", fundingRecoveredAt: new Date() }));
    const reversed = publicFailureReason(delivery({ status: "reversed" }));
    expect(beforeFunding).toBe("Funding failed before any money left the treasury.");
    expect(afterFunding).toBe("The funding transfer left the treasury but the delivery did not complete. The amount stays reserved until the operator resolves it.");
    expect(recovered).toBe("The funding transfer left the treasury and was later returned to it.");
    expect(reversed).toBe("Reversed after delivery.");
    for (const text of [beforeFunding, afterFunding, recovered, reversed]) expect(text).not.toContain("Zentro");
  });

  it("says nothing for deliveries that have not failed", () => {
    for (const status of ["queued", "funding", "funded", "executing", "delivered"] as const) expect(publicFailureReason(delivery({ status }))).toBeNull();
  });
});
