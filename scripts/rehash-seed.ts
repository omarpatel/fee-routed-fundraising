/**
 * Recompute `receiptHash` for every delivered delivery from the canonical receipt, so seeded
 * (synthetic-hash) rows verify locally. Anchor tx signatures are left untouched: the seed's
 * signatures are synthetic and `verifyAnchorOnChain` reports them as not found, which is honest.
 *
 *   pnpm exec tsx scripts/rehash-seed.ts
 */
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { getReceipt } from "../src/lib/db/queries";
import { deliveries } from "../src/lib/db/schema";
import { canonicalReceipt, receiptHash, verifyReceipt } from "../src/lib/proof";

async function main() {
  const rows = await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.status, "delivered"));
  let changed = 0;
  for (const { id } of rows) {
    const detail = (await getReceipt(id))!;
    const hash = receiptHash(canonicalReceipt(detail));
    if (detail.delivery.receiptHash !== hash) {
      await db.update(deliveries).set({ receiptHash: hash }).where(eq(deliveries.id, id));
      changed++;
    }
    const check = verifyReceipt((await getReceipt(id))!);
    console.log(`${id}  ${hash.slice(0, 12)}…  ${check.ok ? "VERIFIED" : "MISMATCH"}`);
  }
  console.log(`rehashed ${changed}/${rows.length} delivered deliveries`);
}

main().then(() => process.exit(0));
