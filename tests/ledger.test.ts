import { Connection, Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { asc, eq } from "drizzle-orm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getReceipt } from "@/lib/db/queries";
import { causes, deliveries, deliveryAllocations, feeEvents, periods, tokens, users, vaults } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { attachArtifact, claimDelivery, closePeriods, connectToken, deliverable, ensureOpenPeriod, finalizeDelivery, LedgerError, markExecuting, markFailed, markFunded, queueDelivery, recoverStrandedFunding, verifyRoute } from "@/lib/ledger";
import { ingestHeliusTx, retryFailedIngests, routeIndex } from "@/lib/ledger/ingest";
import { verifyReceipt } from "@/lib/proof";
import type { HeliusEnhancedTx } from "@/lib/solana/helius";
import { anchorMemo } from "@/lib/solana/memo";
import type * as Memo from "@/lib/solana/memo";
import { JUPITER_PROGRAM_ID, PUMPFUN_PROGRAM_ID, SOL_MINT, USDC_MINT } from "@/lib/solana/rpc";
import { rows } from "./fixtures";

// Anchoring is unconfigured in tests (null); a test can hold it open to probe the sealing window.
vi.mock("@/lib/solana/memo", async (importOriginal) => ({ ...(await importOriginal<typeof Memo>()), anchorMemo: vi.fn(async () => null) }));

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const cents = (n: number) => Math.round(n * 100);

async function allocationsOf(deliveryId: string) {
  const a = await db.select().from(deliveryAllocations).where(eq(deliveryAllocations.deliveryId, deliveryId)).orderBy(asc(deliveryAllocations.tokenId));
  return Object.fromEntries(a.map((x) => [x.tokenId, x.amountUsdc]));
}

/** Vault with two tokens: A has $100 of fees across two events, B has $33.33. */
async function seedVault(id: string, over: { donateBps?: number; createdAt?: Date; feesA?: number[]; feesB?: number[] } = {}) {
  const now = new Date();
  await db.insert(causes).values(rows.cause(`cse_${id}`, { verificationStatus: "verified" }));
  await db.insert(vaults).values(rows.vault(id, `cse_${id}`, { donateBps: over.donateBps ?? 10000, createdAt: over.createdAt ?? new Date(now.getTime() - 3 * DAY) }));
  await db.insert(tokens).values([rows.token(`${id}_a`, id), rows.token(`${id}_b`, id)]);
  const fees: (typeof feeEvents.$inferInsert)[] = [];
  (over.feesA ?? [60, 40]).forEach((usd, i) => fees.push(rows.fee(`${id}_fa${i}`, id, `${id}_a`, usd, new Date(now.getTime() - DAY))));
  (over.feesB ?? [33.33]).forEach((usd, i) => fees.push(rows.fee(`${id}_fb${i}`, id, `${id}_b`, usd, new Date(now.getTime() - DAY))));
  await db.insert(feeEvents).values(fees);
  return { vaultId: id, a: `${id}_a`, b: `${id}_b` };
}

describe("queueDelivery", () => {
  it("allocates pro-rata by undelivered fees, in cents, summing exactly to the amount", async () => {
    const v = await seedVault("v1");
    const d = await queueDelivery(v.vaultId, 100);
    expect(d.amountUsdc).toBe(100);
    expect(d.ordinal).toBe(1);
    expect(d.status).toBe("queued");
    expect(d.rail).toBe("operator_card");
    const a = await allocationsOf(d.id);
    // 100 * 100/133.33 = 75.0018 → 75.00 (floor); B's 24.9981 has the larger remainder and takes the leftover cent.
    expect(a).toEqual({ [v.a]: 75, [v.b]: 25 });
    expect(Object.values(a).reduce((s, x) => s + cents(x), 0)).toBe(cents(d.amountUsdc));
  });

  it("hands leftover cents to the largest remainders so allocations never drift from the amount", async () => {
    const v = await seedVault("v2", { feesA: [10], feesB: [20] });
    const d = await queueDelivery(v.vaultId, 10);
    // 10 * 10/30 = 3.333… → 3.33; B's 6.666… rounds up to 6.67.
    expect(await allocationsOf(d.id)).toEqual({ [v.a]: 3.33, [v.b]: 6.67 });
  });

  it("never charges a token more than its own undelivered balance", async () => {
    await db.insert(causes).values(rows.cause("cse_v2b", { verificationStatus: "verified" }));
    await db.insert(vaults).values(rows.vault("v2b", "cse_v2b", { createdAt: new Date(Date.now() - 3 * DAY) }));
    await db.insert(tokens).values([rows.token("v2b_a", "v2b"), rows.token("v2b_b", "v2b"), rows.token("v2b_c", "v2b")]);
    const t = new Date(Date.now() - DAY);
    await db.insert(feeEvents).values([rows.fee("v2b_fa", "v2b", "v2b_a", 100, t), rows.fee("v2b_fb", "v2b", "v2b_b", 100, t), rows.fee("v2b_fc", "v2b", "v2b_c", 0.01, t)]);
    const d = await queueDelivery("v2b", 200);
    const a = await allocationsOf(d.id);
    expect(Object.values(a).reduce((s, x) => s + cents(x), 0)).toBe(20000);
    expect(cents(a["v2b_c"] ?? 0)).toBeLessThanOrEqual(1);
    // $200.01 of fees, $200 delivered: exactly one cent is left, never two.
    expect((await deliverable("v2b")).totalUsd).toBe(0.01);
  });

  it("caps the amount at what is deliverable", async () => {
    const v = await seedVault("v3");
    const d = await queueDelivery(v.vaultId, 5000);
    expect(d.amountUsdc).toBe(133.33);
    expect(await allocationsOf(d.id)).toEqual({ [v.a]: 100, [v.b]: 33.33 });
  });

  it("applies donateBps to the deliverable share", async () => {
    const v = await seedVault("v4", { donateBps: 5000 });
    expect((await deliverable(v.vaultId)).totalUsd).toBe(66.67);
    const d = await queueDelivery(v.vaultId, 1000);
    expect(d.amountUsdc).toBe(66.67);
  });

  it("counts an in-flight delivery against the balance, increments the ordinal, and rejects when nothing is left", async () => {
    const v = await seedVault("v5");
    const first = await queueDelivery(v.vaultId, 100);
    const mid = await deliverable(v.vaultId);
    expect(mid.totalUsd).toBe(33.33);
    expect(mid.inFlight).toBe(1);

    const second = await queueDelivery(v.vaultId, 100);
    expect(second.ordinal).toBe(first.ordinal + 1);
    expect(second.amountUsdc).toBe(33.33);
    expect(await allocationsOf(second.id)).toEqual({ [v.a]: 25, [v.b]: 8.33 });

    await expect(queueDelivery(v.vaultId, 1)).rejects.toMatchObject({ name: "LedgerError", status: 409 });
    expect((await deliverable(v.vaultId)).totalUsd).toBe(0);
  });

  it("rejects non-positive amounts and paused vaults", async () => {
    const v = await seedVault("v6");
    await expect(queueDelivery(v.vaultId, 0)).rejects.toBeInstanceOf(LedgerError);
    await expect(queueDelivery(v.vaultId, -5)).rejects.toBeInstanceOf(LedgerError);
    await db.update(vaults).set({ status: "paused" }).where(eq(vaults.id, v.vaultId));
    await expect(queueDelivery(v.vaultId, 10)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses causes that are not verified, so the worker never auto-pays a pending or rejected cause", async () => {
    const v = await seedVault("v6b");
    for (const status of ["unverified", "pending", "rejected"] as const) {
      await db.update(causes).set({ verificationStatus: status }).where(eq(causes.id, "cse_v6b"));
      await expect(queueDelivery(v.vaultId, 10)).rejects.toMatchObject({ name: "LedgerError", status: 409 });
    }
    expect((await deliverable(v.vaultId)).inFlight).toBe(0);
  });
});

describe("markFailed", () => {
  it("releases the in-flight amount back to the deliverable balance", async () => {
    const v = await seedVault("v7");
    const d = await queueDelivery(v.vaultId, 100);
    expect((await deliverable(v.vaultId)).totalUsd).toBe(33.33);
    const failed = await markFailed(d.id, "card declined");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("card declined");
    const after = await deliverable(v.vaultId);
    expect(after.totalUsd).toBe(133.33);
    expect(after.inFlight).toBe(0);
    // The failed row keeps its ordinal; the next delivery takes the next number and the whole balance.
    const next = await queueDelivery(v.vaultId, 1000);
    expect(next.ordinal).toBe(d.ordinal + 1);
    expect(next.amountUsdc).toBe(133.33);
  });

  it("refuses to fail a delivery whose money is already on the rail", async () => {
    const v = await seedVault("v7b");
    const d = await queueDelivery(v.vaultId, 100);
    await markFunded(d.id, "sig");
    await expect(markFailed(d.id, "oops")).rejects.toMatchObject({ name: "LedgerError", status: 409 });
    expect((await db.select().from(deliveries).where(eq(deliveries.id, d.id)).get())!.status).toBe("funded");
    expect((await deliverable(v.vaultId)).totalUsd).toBe(33.33);
  });

  it("keeps a failed delivery whose USDC already left the treasury counted, so the ops reserve never pays the next one", async () => {
    const v = await seedVault("v7c", { donateBps: 5000 });
    const d = await queueDelivery(v.vaultId, 1000);
    expect(d.amountUsdc).toBe(66.67);
    // Card top-up sent to Zentro, then the bridge expired: the USDC is gone but the cause never got it.
    await claimDelivery(d.id, "queued", "funding", { fundingTxSig: "v7c_topup" });
    await markFailed(d.id, "Zentro top-up expired");
    const after = await deliverable(v.vaultId);
    expect(after.inFlight).toBe(0);
    expect(after.totalUsd).toBe(0);
    await expect(queueDelivery(v.vaultId, 1)).rejects.toMatchObject({ status: 409 });
  });
});

describe("recoverStrandedFunding", () => {
  /** Process-wide Connection where `refund` credits `treasury` with `rawUsdc` base units; treasury balance lookups are down. */
  function stubRefund(refund: string, treasury: string, rawUsdc: string) {
    const conn = new Connection("http://127.0.0.1:9");
    const usdc = (amount: string) => [{ accountIndex: 1, mint: USDC_MINT.toBase58(), owner: treasury, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "" } }];
    // Only the fields the recovery check reads.
    const parsed = { meta: { err: null, preTokenBalances: usdc("0"), postTokenBalances: usdc(rawUsdc) } } as unknown as ParsedTransactionWithMeta;
    vi.spyOn(conn, "getParsedTransaction").mockImplementation(async (sig) => (sig === refund ? parsed : null));
    vi.spyOn(conn, "getAccountInfo").mockRejectedValue(new Error("rpc down"));
    // rpc() hands out this process-wide slot.
    const slot = globalThis as unknown as { __feeRouterRpc?: Connection };
    slot.__feeRouterRpc = conn;
  }

  it("releases stranded funding only against a verified refund into the treasury, once", async () => {
    const v = await seedVault("vrec", { donateBps: 5000 });
    await db.insert(users).values({ id: "usr_ops", googleSub: "ops", email: "ops@test.local", walletAddress: "usr_ops_wallet", createdAt: new Date(), lastLoginAt: new Date() });
    const d = await queueDelivery(v.vaultId, 1000);
    await claimDelivery(d.id, "queued", "funding", { fundingTxSig: "vrec_topup" });
    await markFailed(d.id, "Zentro top-up expired");
    expect((await deliverable(v.vaultId)).ledgerUsd).toBe(0);
    const recover = (txSig: string) => recoverStrandedFunding(d.id, { txSig, operatorUserId: "usr_ops" });

    // Never recorded unverified.
    await expect(recover("vrec_refund")).rejects.toMatchObject({ status: 503 });

    const flags: { rpc: boolean } = configured;
    flags.rpc = true;
    try {
      stubRefund("vrec_short", "vrec_treasury", "66660000");
      await expect(recover("vrec_short")).rejects.toMatchObject({ status: 400 });
      await expect(recover("vrec_unknown")).rejects.toMatchObject({ status: 400 });
      stubRefund("vrec_refund", "vrec_treasury", "66670000");
      const r = await recover("vrec_refund");
      expect(r).toMatchObject({ status: "failed", fundingTxSig: "vrec_topup", fundingRecoveryTxSig: "vrec_refund", fundingRecoveredBy: "usr_ops" });
      expect(r.fundingRecoveredAt).not.toBeNull();
      expect((await deliverable(v.vaultId)).ledgerUsd).toBe(66.67);
      await expect(recover("vrec_refund")).rejects.toMatchObject({ status: 409 });
    } finally {
      flags.rpc = false;
    }
  });
});

describe("claimDelivery", () => {
  it("moves the row exactly once under concurrent claims and only from the named statuses", async () => {
    const v = await seedVault("v11");
    const d = await queueDelivery(v.vaultId, 50);
    const results = await Promise.all(Array.from({ length: 5 }, () => claimDelivery(d.id, "queued", "funding", { bridgeStatus: "waiting" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = (await db.select().from(deliveries).where(eq(deliveries.id, d.id)).get())!;
    expect(row.status).toBe("funding");
    expect(row.bridgeStatus).toBe("waiting");
    expect(await claimDelivery(d.id, "queued", "funded")).toBe(false);
    expect(await claimDelivery(d.id, ["queued", "funding"], "funded")).toBe(true);
    await expect(markFunded(d.id, "sig")).rejects.toMatchObject({ status: 409 });
  });

});

describe("deliverable", () => {
  it("reports the ledger view and the treasury cap explicitly", async () => {
    const v = await seedVault("v12");
    const d = await deliverable(v.vaultId);
    expect(d.ledgerUsd).toBe(133.33);
    expect(d.deliverableUsd).toBe(133.33);
    expect(d.totalUsd).toBe(d.deliverableUsd);
    expect(d.treasuryUsd).toBeNull(); // no RPC configured in tests
    expect(d.cappedBy).toBe("ledger");
  });

  it("ignores fee events denominated in anything but SOL or USDC", async () => {
    const v = await seedVault("v13");
    await db.insert(feeEvents).values(rows.fee("v13_junk", v.vaultId, v.a, 1_000_000, new Date(), { assetMint: "JunkMint111" }));
    expect((await deliverable(v.vaultId)).ledgerUsd).toBe(133.33);
  });
});

describe("finalizeDelivery", () => {
  it("seals a matched card delivery: delivered, verifiable hash, no anchor without RPC, period total updated", async () => {
    const v = await seedVault("v8");
    const queued = await queueDelivery(v.vaultId, 100);
    expect(queued.periodId).not.toBeNull();
    await markFunded(queued.id, "fundingSig");
    await markExecuting(queued.id, { cardTxId: "ctx_1", cardTxMerchant: "GOFUNDME*HOPEWARD", cardTxAt: new Date() });

    const done = await finalizeDelivery(queued.id, { railRef: "4242/AUTH1", amountFiat: 100, fiatCurrency: "USD", fxRate: 1, executedByUserId: null });
    expect(done.status).toBe("delivered");
    expect(done.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.anchorTxSig).toBeNull();
    expect(done.deliveredAt).toBeInstanceOf(Date);

    const receipt = (await getReceipt(queued.id))!;
    const check = verifyReceipt(receipt);
    expect(check.ok).toBe(true);
    expect(check.computedHash).toBe(done.receiptHash);

    const period = (await db.select().from(periods).where(eq(periods.id, queued.periodId!)).get())!;
    expect(period.deliveredUsd).toBe(100);
    // Delivered money is no longer deliverable.
    expect((await deliverable(v.vaultId)).totalUsd).toBe(33.33);
  });

  it("lets exactly one of two concurrent finalize calls seal the receipt and counts the amount once", async () => {
    const v = await seedVault("v8b");
    const d = await queueDelivery(v.vaultId, 60);
    await markFunded(d.id, "sig");
    await markExecuting(d.id, { cardTxId: "ctx_2", cardTxMerchant: "GOFUNDME", cardTxAt: new Date() });
    const input = { railRef: "r", amountFiat: 60, executedByUserId: null };
    const outcomes = await Promise.allSettled([finalizeDelivery(d.id, input), finalizeDelivery(d.id, input)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ name: "LedgerError", status: 409 });
    const period = (await db.select().from(periods).where(eq(periods.id, d.periodId!)).get())!;
    expect(period.deliveredUsd).toBe(60);
    expect(verifyReceipt((await getReceipt(d.id))!).ok).toBe(true);
  });

  it("refuses to seal an already delivered receipt again", async () => {
    const v = await seedVault("v8c");
    const d = await queueDelivery(v.vaultId, 30);
    await markFunded(d.id, "sig");
    await markExecuting(d.id, { cardTxId: "ctx_3", cardTxMerchant: "GOFUNDME", cardTxAt: new Date() });
    const first = await finalizeDelivery(d.id, { railRef: "r", amountFiat: 30, executedByUserId: null });
    await expect(finalizeDelivery(d.id, { railRef: "r2", amountFiat: 31, executedByUserId: null })).rejects.toMatchObject({ status: 409 });
    const row = (await db.select().from(deliveries).where(eq(deliveries.id, d.id)).get())!;
    expect(row.receiptHash).toBe(first.receiptHash);
    expect(row.railRef).toBe("r");
  });

  it("refuses to seal a card delivery that has no evidence and no matched purchase", async () => {
    const v = await seedVault("v9");
    const d = await queueDelivery(v.vaultId, 50);
    await markFunded(d.id, "sig");
    await expect(finalizeDelivery(d.id, { railRef: "x", amountFiat: 50, executedByUserId: null })).rejects.toThrow(/artifact/);
    expect((await db.select().from(deliveries).where(eq(deliveries.id, d.id)).get())!.status).toBe("funded");
  });

  it("refuses to seal a delivery that is not funded", async () => {
    const v = await seedVault("v10");
    const d = await queueDelivery(v.vaultId, 50);
    await expect(finalizeDelivery(d.id, { executedByUserId: null })).rejects.toMatchObject({ status: 409 });
  });

  it("never lets evidence land between hashing and sealing, so the sealed hash covers every artifact on the receipt", async () => {
    const v = await seedVault("v8d");
    const d = await queueDelivery(v.vaultId, 40);
    await markFunded(d.id, "sig");
    await markExecuting(d.id, { cardTxId: "ctx_4", cardTxMerchant: "GOFUNDME", cardTxAt: new Date() });
    const anchoring = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.mocked(anchorMemo).mockImplementationOnce(async () => {
      anchoring.resolve();
      await gate.promise;
      return null;
    });
    const sealing = finalizeDelivery(d.id, { railRef: "r", amountFiat: 40, executedByUserId: null });
    await anchoring.promise; // the hash is computed; the memo is in flight
    const late = attachArtifact(d.id, { kind: "screenshot", label: "late upload", url: "/late.png", sha256: "ab".repeat(32), bytes: 1 }).catch((e: unknown) => e);
    // One macrotask turn: an upload nothing holds back finishes (its DB calls are synchronous) before the memo returns.
    await nextTurn();
    gate.resolve();
    expect((await sealing).status).toBe("delivered");
    expect(await late).toMatchObject({ name: "LedgerError", status: 409 });
    expect(verifyReceipt((await getReceipt(d.id))!).ok).toBe(true);
  });
});

describe("periods", () => {
  const T0 = Date.UTC(2026, 2, 4, 15, 30); // a Wednesday afternoon; the vault's first day starts at 00:00 UTC
  const DAY0 = Date.UTC(2026, 2, 4);

  beforeAll(async () => {
    await db.insert(causes).values(rows.cause("cse_p"));
    await db.insert(vaults).values(rows.vault("vp", "cse_p", { createdAt: new Date(T0) }));
    await db.insert(tokens).values(rows.token("vp_t", "vp"));
    await db.insert(feeEvents).values([
      rows.fee("vp_f1", "vp", "vp_t", 10, new Date(DAY0 + 2 * DAY)), // week 1
      rows.fee("vp_f2", "vp", "vp_t", 20, new Date(DAY0 + WEEK + DAY)), // week 2
      rows.fee("vp_f3", "vp", "vp_t", 5, new Date(DAY0 + 3 * WEEK)), // week 4, first instant
    ]);
  });

  it("creates contiguous weekly windows from the vault's first UTC day up to now", async () => {
    const open = await ensureOpenPeriod("vp", new Date(DAY0 + 2 * WEEK + 3 * DAY));
    expect(open.label).toBe("Week 3");
    expect(open.status).toBe("open");
    const all = await db.select().from(periods).where(eq(periods.vaultId, "vp")).orderBy(asc(periods.startsAt));
    expect(all.map((p) => p.label)).toEqual(["Week 1", "Week 2", "Week 3"]);
    expect(all[0].startsAt.getTime()).toBe(DAY0);
    for (let i = 1; i < all.length; i++) expect(all[i].startsAt.getTime()).toBe(all[i - 1].endsAt.getTime());
    for (const p of all) expect(p.endsAt.getTime() - p.startsAt.getTime()).toBe(WEEK);
    expect(all.map((p) => p.status)).toEqual(["closed", "closed", "open"]);
    expect(all.map((p) => p.feesUsd)).toEqual([10, 20, 0]);
  });

  it("is idempotent while now stays inside the open window", async () => {
    const again = await ensureOpenPeriod("vp", new Date(DAY0 + 2 * WEEK + 6 * DAY));
    expect(again.label).toBe("Week 3");
    expect((await db.select().from(periods).where(eq(periods.vaultId, "vp"))).length).toBe(3);
  });

  it("closePeriods freezes the ended window's fees and opens the next without gaps", async () => {
    const r = await closePeriods("vp", new Date(DAY0 + 3 * WEEK + DAY));
    expect(r.closed).toBe(1);
    expect(r.open.label).toBe("Week 4");
    const all = await db.select().from(periods).where(eq(periods.vaultId, "vp")).orderBy(asc(periods.startsAt));
    expect(all.map((p) => [p.label, p.status, p.feesUsd])).toEqual([
      ["Week 1", "closed", 10],
      ["Week 2", "closed", 20],
      ["Week 3", "closed", 0],
      ["Week 4", "open", 0],
    ]);
    expect(all[3].startsAt.getTime()).toBe(all[2].endsAt.getTime());
    expect(all[3].startsAt.getTime()).toBe(DAY0 + 3 * WEEK);
  });

  it("closePeriods is a no-op when the open window has not ended", async () => {
    const r = await closePeriods("vp", new Date(DAY0 + 3 * WEEK + 2 * DAY));
    expect(r.closed).toBe(0);
    expect(r.open.label).toBe("Week 4");
  });

  it("keeps a week's fees when a delivery queued after the rollover is what closes it", async () => {
    await db.insert(causes).values(rows.cause("cse_pq"));
    await db.insert(vaults).values(rows.vault("pq", "cse_pq", { createdAt: new Date(T0) }));
    await db.insert(tokens).values(rows.token("pq_t", "pq"));
    await db.insert(feeEvents).values(rows.fee("pq_f1", "pq", "pq_t", 12.5, new Date(DAY0 + 2 * DAY)));
    expect((await ensureOpenPeriod("pq", new Date(DAY0 + 3 * DAY))).label).toBe("Week 1");
    // queueDelivery → ensureOpenPeriod notices the rollover before the worker's closePeriods does.
    await ensureOpenPeriod("pq", new Date(DAY0 + WEEK + DAY));
    await closePeriods("pq", new Date(DAY0 + WEEK + DAY));
    const all = await db.select().from(periods).where(eq(periods.vaultId, "pq")).orderBy(asc(periods.startsAt));
    expect(all.map((p) => [p.label, p.status, p.feesUsd])).toEqual([
      ["Week 1", "closed", 12.5],
      ["Week 2", "open", 0],
    ]);
  });
});

describe("ingestHeliusTx", () => {
  const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const usdcTo = (route: string, signature: string, over: Partial<HeliusEnhancedTx>): HeliusEnhancedTx => ({
    signature,
    slot: 1,
    timestamp: Math.floor(Date.now() / 1000),
    accountData: [{ account: `${route}_usdc_ata`, nativeBalanceChange: 0, tokenBalanceChanges: [{ mint: USDC_MINT.toBase58(), rawTokenAmount: { tokenAmount: "5000000", decimals: 6 }, userAccount: route }] }],
    ...over,
  });

  it("does not book the sweep's own swap output as new fees, but books what donors send and fee claims the route signs", async () => {
    const v = await seedVault("vi");
    const route = "vi_a_route";
    const routes = await routeIndex();
    expect((await deliverable(v.vaultId)).ledgerUsd).toBe(133.33);
    // Sweep: the route pays for a Jupiter swap whose USDC lands on the route before moving to the treasury.
    expect((await ingestHeliusTx(usdcTo(route, "vi_swap", { feePayer: route, instructions: [{ programId: JUPITER_PROGRAM_ID }] }), routes)).inserted).toBe(0);
    expect((await deliverable(v.vaultId)).ledgerUsd).toBe(133.33);
    expect((await ingestHeliusTx(usdcTo(route, "vi_gift", { feePayer: "donor" }), routes)).inserted).toBe(1);
    expect((await ingestHeliusTx(usdcTo(route, "vi_claim", { feePayer: route, instructions: [{ programId: PUMPFUN_PROGRAM_ID }] }), routes)).inserted).toBe(1);
    // A graduated token's claim runs on PumpSwap, which is not a fee-source program and may carry no PUMP_AMM label.
    expect((await ingestHeliusTx(usdcTo(route, "vi_amm_claim", { feePayer: route, instructions: [{ programId: PUMPSWAP_PROGRAM_ID }] }), routes)).inserted).toBe(1);
    expect((await deliverable(v.vaultId)).ledgerUsd).toBe(148.33);
  });

  it("books a fee whose first valuation failed once the price feed is back, though the webhook is never redelivered", async () => {
    await seedVault("vr");
    const routes = await routeIndex();
    const tx: HeliusEnhancedTx = { signature: "vr_fee", slot: 1, timestamp: Math.floor(Date.now() / 1000), source: "PUMP_FUN", nativeTransfers: [{ fromUserAccount: "creator_vault", toUserAccount: "vr_a_route", amount: 1_000_000_000 }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    try {
      expect((await ingestHeliusTx(tx, routes)).error).toMatch(/Jupiter price 503/);
      expect((await ingestHeliusTx(tx, routes)).duplicate).toBe(true);
      fetchMock.mockImplementation(async () => Response.json({ [SOL_MINT]: { usdPrice: 150 } }));
      expect((await retryFailedIngests()).map((r) => [r.signature, r.inserted, r.error])).toEqual([["vr_fee", 1, null]]);
      expect((await db.select().from(feeEvents).where(eq(feeEvents.txSig, "vr_fee"))).map((f) => [f.amountUsd, f.kind])).toEqual([[150, "creator_fee"]]);
      expect(await retryFailedIngests()).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("token connections", () => {
  /** Process-wide Connection whose only history is one pump.fun fee inflow into `route`. */
  function stubRouteHistory(route: string) {
    const conn = new Connection("http://127.0.0.1:9");
    vi.spyOn(conn, "getSignaturesForAddress").mockImplementation(async (address) => (address.toBase58() === route ? [{ signature: "proof_sig", slot: 1, err: null, memo: null, blockTime: null }] : []));
    // Only the fields verifyRoute reads; the rest of the parsed-transaction shape is irrelevant here.
    const inflow = {
      transaction: { message: { instructions: [{ programId: new PublicKey(PUMPFUN_PROGRAM_ID) }], accountKeys: [{ pubkey: new PublicKey(route) }] } },
      meta: { innerInstructions: [], preBalances: [0], postBalances: [1_000_000] },
    } as unknown as ParsedTransactionWithMeta;
    vi.spyOn(conn, "getParsedTransaction").mockResolvedValue(inflow);
    // rpc() hands out this process-wide slot.
    const slot = globalThis as unknown as { __feeRouterRpc?: Connection };
    slot.__feeRouterRpc = conn;
  }

  async function vaultFor(id: string) {
    await db.insert(causes).values(rows.cause(`cse_${id}`));
    await db.insert(vaults).values(rows.vault(id, `cse_${id}`));
    return id;
  }

  it("lets several vaults connect a mint until one proves its route; locking detaches the rest and later connects are refused", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const connect = (vaultId: string) => connectToken({ vaultId, mint, symbol: "SQT", name: "Squat", source: "pumpfun" });
    const squatter = await connect(await vaultFor("tc_squat"));
    const earner = await connect(await vaultFor("tc_earn"));
    const creator = await connect(await vaultFor("tc_real"));
    expect(new Set([squatter.routeAddress, earner.routeAddress, creator.routeAddress]).size).toBe(3);
    // One vault connecting the same mint twice is still a duplicate.
    await expect(connect("tc_squat")).rejects.toMatchObject({ status: 409, message: "Token already connected" });
    // Fees reached the earner's route before the creator proved theirs: that history must stay attributable.
    await db.insert(feeEvents).values(rows.fee("tc_earn_fee", "tc_earn", earner.id, 5, new Date()));

    stubRouteHistory(creator.routeAddress);
    const r = await verifyRoute(creator.id);
    expect(r).toMatchObject({ verified: true, locked: true, proofTx: "proof_sig" });

    const left = await db.select().from(tokens).where(eq(tokens.mint, mint));
    expect(left.map((t) => [t.id, t.routeLocked, t.supersededAt !== null]).sort()).toEqual([
      [creator.id, true, false],
      [earner.id, false, true],
    ].sort());
    expect((await deliverable("tc_earn")).ledgerUsd).toBe(5);
    await expect(verifyRoute(earner.id)).rejects.toMatchObject({ status: 409 });
    await expect(connect(await vaultFor("tc_late"))).rejects.toMatchObject({ status: 409, message: "Token already connected" });
  });
});
