import { eq } from "drizzle-orm";
import { ApiError, assertVaultOwner, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { tokens, vaults } from "@/lib/db/schema";
import { verifyRoute } from "@/lib/ledger";

/** Re-check the token's fee route against chain (and Bags config when available). */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const session = await requireApiSession();
  const row = await db.select({ vault: vaults }).from(tokens).innerJoin(vaults, eq(vaults.id, tokens.vaultId)).where(eq(tokens.id, id)).get();
  if (!row) throw new ApiError("Token not found", 404);
  assertVaultOwner(session, row.vault);
  return ok(await verifyRoute(id));
});
