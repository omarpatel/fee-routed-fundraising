import { eq } from "drizzle-orm";
import { ApiError, assertVaultOwner, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { tokens, vaults } from "@/lib/db/schema";
import { collectCreatorFeeTx, pumpfunCreatorRewardsUrl } from "@/lib/launchpads/pumpfun";

/**
 * Unsigned pump.fun `collectCreatorFee` transaction for the token's creator wallet.
 * The session user must be that creator (their custodial wallet) or the vault owner/operator.
 */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const session = await requireApiSession();
  const row = await db.select({ token: tokens, vault: vaults }).from(tokens).innerJoin(vaults, eq(vaults.id, tokens.vaultId)).where(eq(tokens.id, id)).get();
  if (!row) throw new ApiError("Token not found", 404);
  if (row.token.supersededAt) throw new ApiError("Another vault proved this token's fee route; this connection is superseded", 409);
  if (row.token.source !== "pumpfun") throw new ApiError("Not a pump.fun token", 400);
  if (!row.token.creatorWallet) throw new ApiError("Token has no creator wallet on record", 400);
  if (session.user.walletAddress !== row.token.creatorWallet) assertVaultOwner(session, row.vault);
  const tx = await collectCreatorFeeTx(row.token.creatorWallet);
  return ok({ ...tx, mint: row.token.mint, routeAddress: row.token.routeAddress, redirectUrl: pumpfunCreatorRewardsUrl(row.token.mint) });
});
