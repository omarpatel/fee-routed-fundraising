import { eq } from "drizzle-orm";
import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { deliveries } from "@/lib/db/schema";
import { reconcileDelivery } from "@/lib/zentro/reconcile";
import { ZentroNotConfiguredError } from "@/lib/zentro/session-store";

/** "I paid — check now": match the card purchase, attach evidence, seal the receipt. Operator only. */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  await requireApiSession("operator");
  const d = await db.select().from(deliveries).where(eq(deliveries.id, id)).get();
  if (!d) throw new ApiError("Delivery not found", 404);
  if (d.rail !== "operator_card") throw new ApiError("Only card deliveries are reconciled against the card", 409);
  if (d.status !== "funded" && d.status !== "executing") throw new ApiError(`Delivery is ${d.status}, expected funded`, 409);
  try {
    return ok(await reconcileDelivery(d));
  } catch (e) {
    if (e instanceof ZentroNotConfiguredError) return fail(e.message, 503);
    throw e;
  }
});
