import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "./index";
import {
  causes,
  deliveries,
  deliveryAllocations,
  feeEvents,
  periods,
  receiptArtifacts,
  tokens,
  vaults,
  type Cause,
  type Delivery,
  type DeliveryAllocation,
  type FeeEvent,
  type Period,
  type ReceiptArtifact,
  type Token,
  type Vault,
} from "./schema";

/* ------------------------------------------------------------------ */
/* View models — pages import these names, never raw drizzle rows.     */
/* ------------------------------------------------------------------ */

export interface VaultTotals {
  feesUsd: number;
  deliveredUsd: number;
  pendingUsd: number;
  /** Failed/reversed after the funding transfer left the treasury, not yet recovered: gone from the treasury, never delivered. Still counted against the deliverable balance. */
  strandedUsd: number;
  tokenCount: number;
  deliveryCount: number;
  lastDeliveryAt: Date | null;
  /** Delivered to this vault's cause by every vault funding it: the Fee Router share of the cause's "raised". */
  causeDeliveredUsd: number;
}

export interface VaultCard {
  vault: Vault;
  cause: Cause;
  totals: VaultTotals;
  tokens: Pick<Token, "id" | "symbol" | "imageUrl" | "source">[];
}

export interface TokenWithTotals {
  token: Token;
  feesUsd: number;
  deliveredUsd: number;
  eventCount: number;
  lastEventAt: Date | null;
}

export interface DeliveryWithAllocations {
  delivery: Delivery;
  allocations: (DeliveryAllocation & { token: Pick<Token, "id" | "symbol" | "imageUrl"> })[];
}

export interface VaultDetail {
  vault: Vault;
  cause: Cause;
  totals: VaultTotals;
  tokens: TokenWithTotals[];
  periods: Period[];
  deliveries: DeliveryWithAllocations[];
  recentFees: (FeeEvent & { token: Pick<Token, "id" | "symbol" | "imageUrl"> })[];
}

export interface ReceiptDetail {
  delivery: Delivery;
  vault: Vault;
  cause: Cause;
  allocations: DeliveryWithAllocations["allocations"];
  artifacts: ReceiptArtifact[];
  period: Period | null;
}

export interface GlobalStats {
  feesUsd: number;
  deliveredUsd: number;
  vaults: number;
  tokens: number;
  deliveries: number;
  causes: number;
}

export interface DeliveryTickerItem {
  id: string;
  ordinal: number;
  amountUsdc: number;
  deliveredAt: Date;
  vaultSlug: string;
  vaultName: string;
  causeTitle: string;
  rail: Delivery["rail"];
  topSymbol: string | null;
}

/* ------------------------------------------------------------------ */

const sum = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)`;

async function totalsForVaults(vaultIds: string[]): Promise<Map<string, VaultTotals>> {
  const out = new Map<string, VaultTotals>();
  if (vaultIds.length === 0) return out;
  for (const id of vaultIds) out.set(id, { feesUsd: 0, deliveredUsd: 0, pendingUsd: 0, strandedUsd: 0, tokenCount: 0, deliveryCount: 0, lastDeliveryAt: null, causeDeliveredUsd: 0 });

  const fees = await db
    .select({ vaultId: feeEvents.vaultId, usd: sum(feeEvents.amountUsd) })
    .from(feeEvents)
    .where(inArray(feeEvents.vaultId, vaultIds))
    .groupBy(feeEvents.vaultId);
  for (const r of fees) out.get(r.vaultId)!.feesUsd = r.usd;

  const delivered = await db
    .select({
      vaultId: deliveries.vaultId,
      usd: sum(deliveries.amountUsdc),
      n: sql<number>`count(*)`,
      last: sql<number | null>`max(${deliveries.deliveredAt})`,
    })
    .from(deliveries)
    .where(and(inArray(deliveries.vaultId, vaultIds), eq(deliveries.status, "delivered")))
    .groupBy(deliveries.vaultId);
  for (const r of delivered) {
    const t = out.get(r.vaultId)!;
    t.deliveredUsd = r.usd;
    t.deliveryCount = r.n;
    t.lastDeliveryAt = r.last ? new Date(r.last) : null;
  }

  const pending = await db
    .select({ vaultId: deliveries.vaultId, usd: sum(deliveries.amountUsdc) })
    .from(deliveries)
    .where(and(inArray(deliveries.vaultId, vaultIds), inArray(deliveries.status, ["queued", "funding", "funded", "executing"])))
    .groupBy(deliveries.vaultId);
  for (const r of pending) out.get(r.vaultId)!.pendingUsd = r.usd;

  // Same rows the ledger's `counted` keeps against the balance beyond in-flight and delivered.
  const stranded = await db
    .select({ vaultId: deliveries.vaultId, usd: sum(deliveries.amountUsdc) })
    .from(deliveries)
    .where(and(inArray(deliveries.vaultId, vaultIds), inArray(deliveries.status, ["failed", "reversed"]), isNotNull(deliveries.fundingTxSig), isNull(deliveries.fundingRecoveredAt)))
    .groupBy(deliveries.vaultId);
  for (const r of stranded) out.get(r.vaultId)!.strandedUsd = r.usd;

  const tc = await db
    .select({ vaultId: tokens.vaultId, n: sql<number>`count(*)` })
    .from(tokens)
    .where(and(inArray(tokens.vaultId, vaultIds), isNull(tokens.supersededAt)))
    .groupBy(tokens.vaultId);
  for (const r of tc) out.get(r.vaultId)!.tokenCount = r.n;

  const causeDelivered = await db
    .select({ vaultId: vaults.id, usd: sum(deliveries.amountUsdc) })
    .from(vaults)
    .innerJoin(deliveries, and(eq(deliveries.causeId, vaults.causeId), eq(deliveries.status, "delivered")))
    .where(inArray(vaults.id, vaultIds))
    .groupBy(vaults.id);
  for (const r of causeDelivered) out.get(r.vaultId)!.causeDeliveredUsd = r.usd;

  return out;
}

export interface VaultFilter {
  status?: Vault["status"];
  causeId?: string;
  ownerUserId?: string;
  category?: Cause["category"];
  /** Only vaults whose cause is verified. */
  verified?: boolean;
}

export type VaultSort = "delivered" | "fees" | "recent";

function vaultWhere(f: VaultFilter) {
  return and(
    f.status ? eq(vaults.status, f.status) : undefined,
    f.causeId ? eq(vaults.causeId, f.causeId) : undefined,
    f.ownerUserId ? eq(vaults.ownerUserId, f.ownerUserId) : undefined,
    f.category ? eq(causes.category, f.category) : undefined,
    f.verified ? eq(causes.verificationStatus, "verified") : undefined,
  );
}

/** Vaults matching `f`, newest first unless sorted by USD delivered or fees routed (ties: newest). Unbounded unless `limit` is set. */
export async function listVaults(opts: VaultFilter & { sort?: VaultSort; limit?: number; offset?: number } = {}): Promise<VaultCard[]> {
  const newest = [desc(vaults.createdAt), desc(vaults.id)];
  let q = db.select({ vault: vaults, cause: causes }).from(vaults).innerJoin(causes, eq(causes.id, vaults.causeId)).where(vaultWhere(opts)).$dynamic();
  if (opts.sort === "delivered") {
    const vd = db
      .select({ vaultId: deliveries.vaultId, usd: sql<number>`sum(${deliveries.amountUsdc})`.as("vault_delivered_usd") })
      .from(deliveries)
      .where(eq(deliveries.status, "delivered"))
      .groupBy(deliveries.vaultId)
      .as("vd");
    q = q.leftJoin(vd, eq(vd.vaultId, vaults.id)).orderBy(desc(sql`coalesce(${vd.usd}, 0)`), ...newest);
  } else if (opts.sort === "fees") {
    const vf = db
      .select({ vaultId: feeEvents.vaultId, usd: sql<number>`sum(${feeEvents.amountUsd})`.as("vault_fees_usd") })
      .from(feeEvents)
      .groupBy(feeEvents.vaultId)
      .as("vf");
    q = q.leftJoin(vf, eq(vf.vaultId, vaults.id)).orderBy(desc(sql`coalesce(${vf.usd}, 0)`), ...newest);
  } else {
    q = q.orderBy(...newest);
  }
  if (opts.limit !== undefined) q = q.limit(opts.limit).offset(opts.offset ?? 0);
  const rows = await q;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.vault.id);
  const [totals, toks] = await Promise.all([
    totalsForVaults(ids),
    db
      .select({ id: tokens.id, symbol: tokens.symbol, imageUrl: tokens.imageUrl, source: tokens.source, vaultId: tokens.vaultId })
      .from(tokens)
      .where(and(inArray(tokens.vaultId, ids), isNull(tokens.supersededAt))),
  ]);
  return rows.map((r) => ({
    vault: r.vault,
    cause: r.cause,
    totals: totals.get(r.vault.id)!,
    tokens: toks.filter((t) => t.vaultId === r.vault.id).map((t) => ({ id: t.id, symbol: t.symbol, imageUrl: t.imageUrl, source: t.source })),
  }));
}

export async function countVaults(f: VaultFilter = {}): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)` }).from(vaults).innerJoin(causes, eq(causes.id, vaults.causeId)).where(vaultWhere(f)).get();
  return r?.n ?? 0;
}

export async function getVaultBySlug(slug: string): Promise<VaultDetail | null> {
  const row = await db.select({ vault: vaults, cause: causes }).from(vaults).innerJoin(causes, eq(causes.id, vaults.causeId)).where(eq(vaults.slug, slug)).get();
  if (!row) return null;
  const vaultId = row.vault.id;

  const [totalsMap, tokenRows, periodRows, deliveryRows, feeRows] = await Promise.all([
    totalsForVaults([vaultId]),
    db.select().from(tokens).where(eq(tokens.vaultId, vaultId)).orderBy(tokens.createdAt),
    db.select().from(periods).where(eq(periods.vaultId, vaultId)).orderBy(desc(periods.startsAt)),
    db.select().from(deliveries).where(eq(deliveries.vaultId, vaultId)).orderBy(desc(deliveries.ordinal)),
    db.select().from(feeEvents).where(eq(feeEvents.vaultId, vaultId)).orderBy(desc(feeEvents.blockTime)).limit(40),
  ]);

  const tokenById = new Map(tokenRows.map((t) => [t.id, t]));
  const brief = (id: string) => {
    const t = tokenById.get(id)!;
    return { id: t.id, symbol: t.symbol, imageUrl: t.imageUrl };
  };

  const perTokenFees = await db
    .select({ tokenId: feeEvents.tokenId, usd: sum(feeEvents.amountUsd), n: sql<number>`count(*)`, last: sql<number | null>`max(${feeEvents.blockTime})` })
    .from(feeEvents)
    .where(eq(feeEvents.vaultId, vaultId))
    .groupBy(feeEvents.tokenId);
  const perTokenDelivered = await db
    .select({ tokenId: deliveryAllocations.tokenId, usd: sum(deliveryAllocations.amountUsdc) })
    .from(deliveryAllocations)
    .innerJoin(deliveries, eq(deliveries.id, deliveryAllocations.deliveryId))
    .where(and(eq(deliveries.vaultId, vaultId), eq(deliveries.status, "delivered")))
    .groupBy(deliveryAllocations.tokenId);

  const allocRows = deliveryRows.length
    ? await db
        .select()
        .from(deliveryAllocations)
        .where(
          inArray(
            deliveryAllocations.deliveryId,
            deliveryRows.map((d) => d.id),
          ),
        )
    : [];

  return {
    vault: row.vault,
    cause: row.cause,
    totals: totalsMap.get(vaultId)!,
    // Superseded connections stay only while they carry history, so attribution still sums to the vault's fees.
    tokens: tokenRows.flatMap((token) => {
      const f = perTokenFees.find((x) => x.tokenId === token.id);
      const d = perTokenDelivered.find((x) => x.tokenId === token.id);
      if (token.supersededAt && !f && !d) return [];
      return [{ token, feesUsd: f?.usd ?? 0, deliveredUsd: d?.usd ?? 0, eventCount: f?.n ?? 0, lastEventAt: f?.last ? new Date(f.last) : null }];
    }),
    periods: periodRows,
    deliveries: deliveryRows.map((delivery) => ({
      delivery,
      allocations: allocRows.filter((a) => a.deliveryId === delivery.id).map((a) => ({ ...a, token: brief(a.tokenId) })),
    })),
    recentFees: feeRows.map((f) => ({ ...f, token: brief(f.tokenId) })),
  };
}

export async function getReceipt(deliveryId: string): Promise<ReceiptDetail | null> {
  const row = await db
    .select({ delivery: deliveries, vault: vaults, cause: causes })
    .from(deliveries)
    .innerJoin(vaults, eq(vaults.id, deliveries.vaultId))
    .innerJoin(causes, eq(causes.id, deliveries.causeId))
    .where(eq(deliveries.id, deliveryId))
    .get();
  if (!row) return null;
  const [allocs, artifacts, period] = await Promise.all([
    db
      .select({ deliveryId: deliveryAllocations.deliveryId, tokenId: deliveryAllocations.tokenId, amountUsdc: deliveryAllocations.amountUsdc, token: { id: tokens.id, symbol: tokens.symbol, imageUrl: tokens.imageUrl } })
      .from(deliveryAllocations)
      .innerJoin(tokens, eq(tokens.id, deliveryAllocations.tokenId))
      .where(eq(deliveryAllocations.deliveryId, deliveryId)),
    db.select().from(receiptArtifacts).where(eq(receiptArtifacts.deliveryId, deliveryId)).orderBy(receiptArtifacts.createdAt),
    row.delivery.periodId ? db.select().from(periods).where(eq(periods.id, row.delivery.periodId)).get() : Promise.resolve(undefined),
  ]);
  return { delivery: row.delivery, vault: row.vault, cause: row.cause, allocations: allocs, artifacts, period: period ?? null };
}

export async function getGlobalStats(): Promise<GlobalStats> {
  const [f, d, v, t, c] = await Promise.all([
    db.select({ usd: sum(feeEvents.amountUsd) }).from(feeEvents).get(),
    db.select({ usd: sum(deliveries.amountUsdc), n: sql<number>`count(*)` }).from(deliveries).where(eq(deliveries.status, "delivered")).get(),
    db.select({ n: sql<number>`count(*)` }).from(vaults).get(),
    db.select({ n: sql<number>`count(*)` }).from(tokens).where(isNull(tokens.supersededAt)).get(),
    db.select({ n: sql<number>`count(*)` }).from(causes).get(),
  ]);
  return { feesUsd: f?.usd ?? 0, deliveredUsd: d?.usd ?? 0, deliveries: d?.n ?? 0, vaults: v?.n ?? 0, tokens: t?.n ?? 0, causes: c?.n ?? 0 };
}

export async function listRecentDeliveries(limit = 12): Promise<DeliveryTickerItem[]> {
  const rows = await db
    .select({ delivery: deliveries, vaultSlug: vaults.slug, vaultName: vaults.name, causeTitle: causes.title })
    .from(deliveries)
    .innerJoin(vaults, eq(vaults.id, deliveries.vaultId))
    .innerJoin(causes, eq(causes.id, deliveries.causeId))
    .where(eq(deliveries.status, "delivered"))
    .orderBy(desc(deliveries.deliveredAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const allocs = await db
    .select({ deliveryId: deliveryAllocations.deliveryId, amount: deliveryAllocations.amountUsdc, symbol: tokens.symbol })
    .from(deliveryAllocations)
    .innerJoin(tokens, eq(tokens.id, deliveryAllocations.tokenId))
    .where(
      inArray(
        deliveryAllocations.deliveryId,
        rows.map((r) => r.delivery.id),
      ),
    );
  return rows.map((r) => {
    const top = allocs.filter((a) => a.deliveryId === r.delivery.id).sort((a, b) => b.amount - a.amount)[0];
    return {
      id: r.delivery.id,
      ordinal: r.delivery.ordinal,
      amountUsdc: r.delivery.amountUsdc,
      deliveredAt: r.delivery.deliveredAt!,
      vaultSlug: r.vaultSlug,
      vaultName: r.vaultName,
      causeTitle: r.causeTitle,
      rail: r.delivery.rail,
      topSymbol: top?.symbol ?? null,
    };
  });
}

export async function listCauses(): Promise<Cause[]> {
  return db.select().from(causes).orderBy(desc(causes.createdAt));
}

/** Fundraisers a human still has to decide on, oldest first so nothing waits forever. */
export async function listCausesAwaitingVerification(): Promise<Cause[]> {
  return db.select().from(causes).where(inArray(causes.verificationStatus, ["pending", "unverified"])).orderBy(causes.createdAt);
}

export async function getCauseBySlug(slug: string): Promise<Cause | null> {
  return (await db.select().from(causes).where(eq(causes.slug, slug)).get()) ?? null;
}

/** Fee events in a window, for period charts. Buckets by day (UTC). */
export async function feeSeries(vaultId: string, from: Date, to: Date): Promise<{ day: string; usd: number }[]> {
  const rows = await db
    .select({ day: sql<string>`date(${feeEvents.blockTime} / 1000, 'unixepoch')`, usd: sum(feeEvents.amountUsd) })
    .from(feeEvents)
    .where(and(eq(feeEvents.vaultId, vaultId), gte(feeEvents.blockTime, from), lt(feeEvents.blockTime, to)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows;
}

export interface VaultBadge {
  deliveredUsd: number;
  deliveryCount: number;
  symbols: string[];
}

/** What the embeddable badge prints: delivered totals and the tokens funding the vault. */
export async function getVaultBadge(slug: string): Promise<VaultBadge | null> {
  const vault = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.slug, slug)).get();
  if (!vault) return null;
  const [d, toks] = await Promise.all([
    db
      .select({ usd: sum(deliveries.amountUsdc), n: sql<number>`count(*)` })
      .from(deliveries)
      .where(and(eq(deliveries.vaultId, vault.id), eq(deliveries.status, "delivered")))
      .get(),
    db
      .select({ symbol: tokens.symbol })
      .from(tokens)
      .where(and(eq(tokens.vaultId, vault.id), isNull(tokens.supersededAt)))
      .orderBy(tokens.createdAt),
  ]);
  return { deliveredUsd: d?.usd ?? 0, deliveryCount: d?.n ?? 0, symbols: toks.map((t) => t.symbol) };
}

export interface LeaderToken {
  token: Pick<Token, "id" | "symbol" | "name" | "imageUrl" | "source">;
  vault: Pick<Vault, "slug" | "name">;
  causeTitle: string;
  feesUsd: number;
  deliveredUsd: number;
}

export interface LeaderVault {
  vault: Pick<Vault, "id" | "slug" | "name">;
  cause: Pick<Cause, "slug" | "title" | "verificationStatus">;
  feesUsd: number;
  deliveredUsd: number;
  deliveryCount: number;
}

/**
 * Tokens and vaults ranked by USD delivered (ties: fees routed) across the whole ledger. A token's
 * delivered figure is the sum of its allocations on delivered receipts. Rows with neither fees nor
 * deliveries are left out.
 */
export async function getLeaderboard(limit = 50): Promise<{ tokens: LeaderToken[]; vaults: LeaderVault[] }> {
  const tokenDelivered = db
    .select({ tokenId: deliveryAllocations.tokenId, usd: sql<number>`sum(${deliveryAllocations.amountUsdc})`.as("token_delivered_usd") })
    .from(deliveryAllocations)
    .innerJoin(deliveries, and(eq(deliveries.id, deliveryAllocations.deliveryId), eq(deliveries.status, "delivered")))
    .groupBy(deliveryAllocations.tokenId)
    .as("td");
  const tokenFees = db
    .select({ tokenId: feeEvents.tokenId, usd: sql<number>`sum(${feeEvents.amountUsd})`.as("token_fees_usd") })
    .from(feeEvents)
    .groupBy(feeEvents.tokenId)
    .as("tf");
  const vaultDelivered = db
    .select({ vaultId: deliveries.vaultId, usd: sql<number>`sum(${deliveries.amountUsdc})`.as("vault_delivered_usd"), n: sql<number>`count(*)`.as("vault_delivery_count") })
    .from(deliveries)
    .where(eq(deliveries.status, "delivered"))
    .groupBy(deliveries.vaultId)
    .as("vd");
  const vaultFees = db
    .select({ vaultId: feeEvents.vaultId, usd: sql<number>`sum(${feeEvents.amountUsd})`.as("vault_fees_usd") })
    .from(feeEvents)
    .groupBy(feeEvents.vaultId)
    .as("vf");

  const tDelivered = sql<number>`coalesce(${tokenDelivered.usd}, 0)`;
  const tFees = sql<number>`coalesce(${tokenFees.usd}, 0)`;
  const vDelivered = sql<number>`coalesce(${vaultDelivered.usd}, 0)`;
  const vFees = sql<number>`coalesce(${vaultFees.usd}, 0)`;

  const [tokenRows, vaultRows] = await Promise.all([
    db
      .select({
        token: { id: tokens.id, symbol: tokens.symbol, name: tokens.name, imageUrl: tokens.imageUrl, source: tokens.source },
        vault: { slug: vaults.slug, name: vaults.name },
        causeTitle: causes.title,
        feesUsd: tFees,
        deliveredUsd: tDelivered,
      })
      .from(tokens)
      .innerJoin(vaults, eq(vaults.id, tokens.vaultId))
      .innerJoin(causes, eq(causes.id, vaults.causeId))
      .leftJoin(tokenDelivered, eq(tokenDelivered.tokenId, tokens.id))
      .leftJoin(tokenFees, eq(tokenFees.tokenId, tokens.id))
      .where(and(isNull(tokens.supersededAt), sql`(${tDelivered} > 0 or ${tFees} > 0)`))
      .orderBy(desc(tDelivered), desc(tFees))
      .limit(limit),
    db
      .select({
        vault: { id: vaults.id, slug: vaults.slug, name: vaults.name },
        cause: { slug: causes.slug, title: causes.title, verificationStatus: causes.verificationStatus },
        feesUsd: vFees,
        deliveredUsd: vDelivered,
        deliveryCount: sql<number>`coalesce(${vaultDelivered.n}, 0)`,
      })
      .from(vaults)
      .innerJoin(causes, eq(causes.id, vaults.causeId))
      .leftJoin(vaultDelivered, eq(vaultDelivered.vaultId, vaults.id))
      .leftJoin(vaultFees, eq(vaultFees.vaultId, vaults.id))
      .where(sql`${vDelivered} > 0 or ${vFees} > 0`)
      .orderBy(desc(vDelivered), desc(vFees))
      .limit(limit),
  ]);
  return { tokens: tokenRows, vaults: vaultRows };
}
