import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { countVaults, getGlobalStats, getLeaderboard, getVaultBadge, getVaultBySlug, listVaults } from "@/lib/db/queries";
import { listSettledDeliveries, listVaultsByOwner } from "@/lib/db/queries.app";
import { causes, deliveries, deliveryAllocations, feeEvents, tokens, users, vaults, type Delivery } from "@/lib/db/schema";
import { rows } from "./fixtures";

const DAY = 86_400_000;

function delivery(id: string, vaultId: string, causeId: string, ordinal: number, status: Delivery["status"], amountUsdc: number, at: Date): typeof deliveries.$inferInsert {
  return { id, ordinal, vaultId, causeId, rail: "operator_card", status, amountUsdc, queuedAt: at, deliveredAt: status === "delivered" ? at : null, failureReason: status === "failed" ? "Zentro top-up expired" : null };
}

describe("listSettledDeliveries", () => {
  it("keeps a fresh failure on the desk even when more deliveries than the limit were delivered earlier", async () => {
    const now = Date.now();
    await db.insert(causes).values(rows.cause("cse_settled"));
    await db.insert(vaults).values(rows.vault("vlt_settled", "cse_settled"));
    const delivered = Array.from({ length: 10 }, (_, i) => delivery(`dlv_ok_${i}`, "vlt_settled", "cse_settled", i + 1, "delivered", 10, new Date(now - (i + 2) * DAY)));
    await db.insert(deliveries).values([...delivered, delivery("dlv_failed", "vlt_settled", "cse_settled", 11, "failed", 10, new Date(now - DAY))]);

    const settled = await listSettledDeliveries(8);
    expect(settled).toHaveLength(8);
    expect(settled[0].delivery.id).toBe("dlv_failed");
    expect(settled[0].delivery.failureReason).toBe("Zentro top-up expired");
  });
});

describe("listVaults", () => {
  it("reports what every vault delivered to the shared cause, so each vault shows the same cause progress", async () => {
    const at = new Date(Date.now() - DAY);
    await db.insert(causes).values([rows.cause("cse_shared"), rows.cause("cse_other")]);
    await db.insert(vaults).values([rows.vault("vlt_a", "cse_shared"), rows.vault("vlt_b", "cse_shared"), rows.vault("vlt_other", "cse_other")]);
    await db.insert(deliveries).values([
      delivery("dlv_a1", "vlt_a", "cse_shared", 1, "delivered", 100.25, at),
      delivery("dlv_b1", "vlt_b", "cse_shared", 1, "delivered", 50.5, at),
      delivery("dlv_b2", "vlt_b", "cse_shared", 2, "queued", 30, at),
      delivery("dlv_b3", "vlt_b", "cse_shared", 3, "failed", 40, at),
      delivery("dlv_o1", "vlt_other", "cse_other", 1, "delivered", 999, at),
    ]);

    const shared = await listVaults({ causeId: "cse_shared" });
    expect(shared.map((v) => v.vault.id).sort()).toEqual(["vlt_a", "vlt_b"]);
    const byId = Object.fromEntries(shared.map((v) => [v.vault.id, v.totals]));
    expect(byId.vlt_a.deliveredUsd).toBe(100.25);
    expect(byId.vlt_b.deliveredUsd).toBe(50.5);
    expect(byId.vlt_a.causeDeliveredUsd).toBe(150.75);
    expect(byId.vlt_b.causeDeliveredUsd).toBe(150.75);

    const [other] = await listVaults({ causeId: "cse_other" });
    expect(other.totals.causeDeliveredUsd).toBe(999);
  });
});

describe("explore listing", () => {
  it("filters, sorts and pages in SQL across more vaults than one page, while the headline counts every vault", async () => {
    const before = await getGlobalStats();
    const at = new Date(Date.now() - DAY);
    await db.insert(causes).values([rows.cause("cse_pg_v", { category: "water", verificationStatus: "verified" }), rows.cause("cse_pg_u", { category: "water" })]);
    // 30 verified vaults, newest last; delivered and fees are two different permutations of 1..30.
    const ids = Array.from({ length: 30 }, (_, i) => `vlt_pg_${String(i).padStart(2, "0")}`);
    const deliveredOf = (i: number) => ((i * 7) % 30) + 1;
    const feesOf = (i: number) => ((i * 11) % 30) + 1;
    await db.insert(vaults).values([
      ...ids.map((id, i) => rows.vault(id, "cse_pg_v", { createdAt: new Date(Date.UTC(2026, 1, 1) + i * DAY) })),
      rows.vault("vlt_pg_u1", "cse_pg_u"),
      rows.vault("vlt_pg_u2", "cse_pg_u"),
    ]);
    await db.insert(tokens).values(ids.map((id) => rows.token(`pgt_${id}`, id)));
    await db.insert(feeEvents).values(ids.map((id, i) => rows.fee(`fee_${id}`, id, `pgt_${id}`, feesOf(i), at)));
    await db.insert(deliveries).values([
      ...ids.map((id, i) => delivery(`dlv_${id}`, id, "cse_pg_v", 1, "delivered", deliveredOf(i), at)),
      delivery("dlv_pg_u1", "vlt_pg_u1", "cse_pg_u", 1, "delivered", 1000, at),
      delivery("dlv_pg_u2", "vlt_pg_u2", "cse_pg_u", 1, "delivered", 1000, at),
    ]);

    const verified = { category: "water", verified: true };
    expect(await countVaults(verified)).toBe(30);
    expect(await countVaults({ category: "water" })).toBe(32);

    const page1 = await listVaults({ ...verified, sort: "delivered", limit: 24, offset: 0 });
    const page2 = await listVaults({ ...verified, sort: "delivered", limit: 24, offset: 24 });
    expect(page1.map((v) => v.totals.deliveredUsd)).toEqual(Array.from({ length: 24 }, (_, i) => 30 - i));
    expect(page2.map((v) => v.totals.deliveredUsd)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(new Set([...page1, ...page2].map((v) => v.vault.id))).toEqual(new Set(ids));

    const byFees = await listVaults({ ...verified, sort: "fees", limit: 24, offset: 24 });
    expect(byFees.map((v) => v.totals.feesUsd)).toEqual([6, 5, 4, 3, 2, 1]);
    const newest = await listVaults({ ...verified, sort: "recent", limit: 3 });
    expect(newest.map((v) => v.vault.id)).toEqual(["vlt_pg_29", "vlt_pg_28", "vlt_pg_27"]);
    // Without the verified filter the unverified cause's vaults lead by delivered.
    expect((await listVaults({ category: "water", sort: "delivered", limit: 2 })).map((v) => v.vault.id).sort()).toEqual(["vlt_pg_u1", "vlt_pg_u2"]);

    const after = await getGlobalStats();
    expect(after.vaults - before.vaults).toBe(32);
    expect(after.deliveries - before.deliveries).toBe(32);
    expect(after.deliveredUsd - before.deliveredUsd).toBe(465 + 2000);
  });
});

describe("getLeaderboard", () => {
  it("ranks by what receipts delivered: queued allocations and fees alone never lift a token or vault", async () => {
    const at = new Date(Date.now() - DAY);
    await db.insert(causes).values(rows.cause("cse_lb"));
    await db.insert(vaults).values([rows.vault("vlt_lb1", "cse_lb"), rows.vault("vlt_lb2", "cse_lb")]);
    await db.insert(tokens).values([rows.token("tok_x", "vlt_lb1"), rows.token("tok_y", "vlt_lb1"), rows.token("tok_z", "vlt_lb2"), rows.token("tok_idle", "vlt_lb2")]);
    await db.insert(feeEvents).values([rows.fee("fee_x", "vlt_lb1", "tok_x", 100, at), rows.fee("fee_y", "vlt_lb1", "tok_y", 300, at), rows.fee("fee_z", "vlt_lb2", "tok_z", 50, at)]);
    await db.insert(deliveries).values([
      delivery("dlv_lb1", "vlt_lb1", "cse_lb", 1, "delivered", 80, at),
      delivery("dlv_lb2", "vlt_lb1", "cse_lb", 2, "queued", 200, at),
      delivery("dlv_lb3", "vlt_lb2", "cse_lb", 1, "delivered", 40, at),
    ]);
    await db.insert(deliveryAllocations).values([
      { deliveryId: "dlv_lb1", tokenId: "tok_x", amountUsdc: 60 },
      { deliveryId: "dlv_lb1", tokenId: "tok_y", amountUsdc: 20 },
      { deliveryId: "dlv_lb2", tokenId: "tok_y", amountUsdc: 200 },
      { deliveryId: "dlv_lb3", tokenId: "tok_z", amountUsdc: 40 },
    ]);

    const board = await getLeaderboard();
    expect(board.tokens.filter((t) => t.token.id.startsWith("tok_")).map((t) => [t.token.id, t.deliveredUsd, t.feesUsd])).toEqual([
      ["tok_x", 60, 100],
      ["tok_z", 40, 50],
      ["tok_y", 20, 300],
    ]);
    expect(board.vaults.filter((v) => v.vault.id.startsWith("vlt_lb")).map((v) => [v.vault.id, v.deliveredUsd, v.feesUsd, v.deliveryCount])).toEqual([
      ["vlt_lb1", 80, 400, 1],
      ["vlt_lb2", 40, 50, 1],
    ]);
  });
});

describe("superseded tokens and stranded funds", () => {
  it("lists only live token connections while vault fees keep every token's history", async () => {
    const at = new Date(Date.now() - DAY);
    await db.insert(users).values({ id: "usr_sup", googleSub: "sup", email: "sup@test.local", walletAddress: "SupWallet", createdAt: at, lastLoginAt: at });
    await db.insert(causes).values(rows.cause("cse_sup"));
    await db.insert(vaults).values(rows.vault("vlt_sup", "cse_sup", { ownerUserId: "usr_sup" }));
    await db.insert(tokens).values([
      rows.token("sup_live", "vlt_sup"),
      // Lost the mint to another vault's locked route but earned fees here first: history, not a connection.
      rows.token("sup_old", "vlt_sup", { supersededAt: at, createdAt: new Date("2026-01-02T00:00:00Z") }),
      rows.token("sup_empty", "vlt_sup", { supersededAt: at, createdAt: new Date("2026-01-03T00:00:00Z") }),
    ]);
    await db.insert(feeEvents).values([rows.fee("fee_sup_live", "vlt_sup", "sup_live", 70, at), rows.fee("fee_sup_old", "vlt_sup", "sup_old", 30, at)]);

    const [card] = await listVaults({ ownerUserId: "usr_sup" });
    expect(card.tokens.map((t) => t.id)).toEqual(["sup_live"]);
    expect(card.totals.tokenCount).toBe(1);
    expect(card.totals.feesUsd).toBe(100);

    const detail = (await getVaultBySlug("vlt_sup"))!;
    expect(detail.tokens.map((t) => [t.token.id, t.feesUsd, t.token.supersededAt !== null])).toEqual([
      ["sup_live", 70, false],
      ["sup_old", 30, true],
    ]);
    expect(detail.tokens.reduce((s, t) => s + t.feesUsd, 0)).toBe(detail.totals.feesUsd);

    expect((await getVaultBadge("vlt_sup"))!.symbols).toEqual(["SUP_LIVE"]);
    expect((await listVaultsByOwner("usr_sup"))[0].tokens.map((t) => t.id)).toEqual(["sup_live"]);
    expect((await getLeaderboard()).tokens.map((t) => t.token.id).filter((id) => id.startsWith("sup_"))).toEqual(["sup_live"]);
  });

  it("reports as stranded exactly the failed or reversed deliveries whose funding left the treasury and was not recovered", async () => {
    const at = new Date(Date.now() - DAY);
    await db.insert(causes).values(rows.cause("cse_str"));
    await db.insert(vaults).values(rows.vault("vlt_str", "cse_str"));
    await db.insert(deliveries).values([
      { ...delivery("dlv_str_1", "vlt_str", "cse_str", 1, "failed", 12.34, at), fundingTxSig: "strSig1" },
      { ...delivery("dlv_str_2", "vlt_str", "cse_str", 2, "reversed", 5, at), fundingTxSig: "strSig2" },
      delivery("dlv_str_3", "vlt_str", "cse_str", 3, "failed", 100, at),
      { ...delivery("dlv_str_4", "vlt_str", "cse_str", 4, "failed", 40, at), fundingTxSig: "strSig4", fundingRecoveredAt: at, fundingRecoveryTxSig: "strBack4" },
      { ...delivery("dlv_str_5", "vlt_str", "cse_str", 5, "funded", 7, at), fundingTxSig: "strSig5" },
    ]);

    const [card] = await listVaults({ causeId: "cse_str" });
    expect(card.totals.strandedUsd).toBe(17.34);
    expect(card.totals.pendingUsd).toBe(7);
    expect(card.totals.deliveredUsd).toBe(0);
  });
});
