import { eq } from "drizzle-orm";
import { ApiError, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { launches, vaults } from "@/lib/db/schema";

/** Launch status for polling after submit. Owner (or operator) only. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const session = await requireApiSession();
  const row = await db.select({ launch: launches, vaultSlug: vaults.slug }).from(launches).innerJoin(vaults, eq(vaults.id, launches.vaultId)).where(eq(launches.id, id)).get();
  if (!row) throw new ApiError("Launch not found", 404);
  const u = session.user;
  if (row.launch.userId !== u.id && u.role !== "operator" && u.role !== "admin") throw new ApiError("Forbidden", 403);
  const { launch } = row;
  return ok({ id: launch.id, status: launch.status, meta: launch.meta, error: launch.error, tokenId: launch.tokenId, vaultSlug: row.vaultSlug, launchpad: launch.launchpad, createdAt: launch.createdAt });
});
