import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from ".";
import { causes, deliveries, deliveryAllocations, tokens, vaults, type Cause, type Delivery, type Token, type Vault } from "./schema";
import type { DeliveryWithAllocations } from "./queries";

/* ------------------------------------------------------------------
   Read models used only by the app pages (cause page, dashboard, ops).
   Kept out of queries.ts so the shared module stays frozen.
   ------------------------------------------------------------------ */

export interface CauseDelivery extends DeliveryWithAllocations {
  vault: Pick<Vault, "id" | "slug" | "name">;
}

async function withAllocations(rows: Delivery[]): Promise<DeliveryWithAllocations[]> {
  if (rows.length === 0) return [];
  const allocs = await db
    .select({ deliveryId: deliveryAllocations.deliveryId, tokenId: deliveryAllocations.tokenId, amountUsdc: deliveryAllocations.amountUsdc, token: { id: tokens.id, symbol: tokens.symbol, imageUrl: tokens.imageUrl } })
    .from(deliveryAllocations)
    .innerJoin(tokens, eq(tokens.id, deliveryAllocations.tokenId))
    .where(
      inArray(
        deliveryAllocations.deliveryId,
        rows.map((d) => d.id),
      ),
    );
  return rows.map((delivery) => ({ delivery, allocations: allocs.filter((a) => a.deliveryId === delivery.id) }));
}

/** Every delivery ever made to a cause, newest first, across all of its vaults. */
export async function listDeliveriesByCause(causeId: string): Promise<CauseDelivery[]> {
  const rows = await db
    .select({ delivery: deliveries, vault: { id: vaults.id, slug: vaults.slug, name: vaults.name } })
    .from(deliveries)
    .innerJoin(vaults, eq(vaults.id, deliveries.vaultId))
    .where(eq(deliveries.causeId, causeId))
    .orderBy(desc(deliveries.queuedAt));
  const withAllocs = await withAllocations(rows.map((r) => r.delivery));
  return withAllocs.map((d, i) => ({ ...d, vault: rows[i].vault }));
}

export interface OwnedVault {
  vault: Vault;
  cause: Pick<Cause, "id" | "slug" | "title" | "platform">;
  tokens: Token[];
}

/** Vaults a user owns, each with its connected tokens (superseded connections left out). */
export async function listVaultsByOwner(userId: string): Promise<OwnedVault[]> {
  const rows = await db
    .select({ vault: vaults, cause: { id: causes.id, slug: causes.slug, title: causes.title, platform: causes.platform } })
    .from(vaults)
    .innerJoin(causes, eq(causes.id, vaults.causeId))
    .where(eq(vaults.ownerUserId, userId))
    .orderBy(desc(vaults.createdAt));
  if (rows.length === 0) return [];
  const toks = await db
    .select()
    .from(tokens)
    .where(
      and(
        inArray(
          tokens.vaultId,
          rows.map((r) => r.vault.id),
        ),
        isNull(tokens.supersededAt),
      ),
    )
    .orderBy(tokens.createdAt);
  return rows.map((r) => ({ ...r, tokens: toks.filter((t) => t.vaultId === r.vault.id) }));
}

export interface OpsDelivery extends DeliveryWithAllocations {
  vault: Pick<Vault, "id" | "slug" | "name" | "treasuryAddress">;
  cause: Pick<Cause, "id" | "slug" | "title" | "platform" | "url" | "onchainAddress">;
}

/** Work queue for the operator desk: everything not yet delivered, oldest first. */
export async function listOpenDeliveries(): Promise<OpsDelivery[]> {
  const rows = await db
    .select({
      delivery: deliveries,
      vault: { id: vaults.id, slug: vaults.slug, name: vaults.name, treasuryAddress: vaults.treasuryAddress },
      cause: { id: causes.id, slug: causes.slug, title: causes.title, platform: causes.platform, url: causes.url, onchainAddress: causes.onchainAddress },
    })
    .from(deliveries)
    .innerJoin(vaults, eq(vaults.id, deliveries.vaultId))
    .innerJoin(causes, eq(causes.id, deliveries.causeId))
    .where(inArray(deliveries.status, ["queued", "funding", "funded", "executing"]))
    .orderBy(deliveries.queuedAt);
  const withAllocs = await withAllocations(rows.map((r) => r.delivery));
  return withAllocs.map((d, i) => ({ ...d, vault: rows[i].vault, cause: rows[i].cause }));
}

/** Recently finished deliveries for the desk's history strip. Failed rows have no deliveredAt, so they sort by when they last moved instead of sinking below every delivered row. */
export async function listSettledDeliveries(limit = 8): Promise<OpsDelivery[]> {
  const rows = await db
    .select({
      delivery: deliveries,
      vault: { id: vaults.id, slug: vaults.slug, name: vaults.name, treasuryAddress: vaults.treasuryAddress },
      cause: { id: causes.id, slug: causes.slug, title: causes.title, platform: causes.platform, url: causes.url, onchainAddress: causes.onchainAddress },
    })
    .from(deliveries)
    .innerJoin(vaults, eq(vaults.id, deliveries.vaultId))
    .innerJoin(causes, eq(causes.id, deliveries.causeId))
    .where(and(inArray(deliveries.status, ["delivered", "failed", "reversed"])))
    .orderBy(desc(sql`coalesce(${deliveries.deliveredAt}, ${deliveries.fundedAt}, ${deliveries.queuedAt})`))
    .limit(limit);
  const withAllocs = await withAllocations(rows.map((r) => r.delivery));
  return withAllocs.map((d, i) => ({ ...d, vault: rows[i].vault, cause: rows[i].cause }));
}
