import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { fail, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { getReceipt } from "@/lib/db/queries";
import { deliveries, vaults } from "@/lib/db/schema";
import { canonicalReceipt, receiptHash, toCanonicalObject } from "@/lib/proof";

/**
 * Public export: every delivered receipt of a vault, as the canonical object plus its hash and
 * anchor. `sha256(JSON.stringify(sortKeys(canonical)))` must equal `hash`; anyone can recheck.
 */
export const GET = route<{ slug: string }>(async (_req, { slug }) => {
  const v = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.slug, slug)).get();
  if (!v) return fail("Vault not found", 404);
  const rows = await db.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.vaultId, v.id), eq(deliveries.status, "delivered"))).orderBy(deliveries.ordinal);
  const out = [];
  for (const { id } of rows) {
    const r = (await getReceipt(id))!;
    const canonical = canonicalReceipt(r);
    out.push({ id, ordinal: r.delivery.ordinal, canonical: toCanonicalObject(r), hash: receiptHash(canonical), storedHash: r.delivery.receiptHash, anchorTxSig: r.delivery.anchorTxSig });
  }
  return NextResponse.json(out, { headers: { "content-disposition": `inline; filename="${slug}-receipts.json"`, "cache-control": "public, max-age=60" } });
});
