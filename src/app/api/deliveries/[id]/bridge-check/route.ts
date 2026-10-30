import { eq } from "drizzle-orm";
import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { deliveries } from "@/lib/db/schema";
import { checkBridge } from "@/lib/zentro/reconcile";
import { ZentroNotConfiguredError } from "@/lib/zentro/session-store";

/** Poll the Zentro top-up invoice now instead of waiting for the worker. Operator only. */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  await requireApiSession("operator");
  const d = await db.select().from(deliveries).where(eq(deliveries.id, id)).get();
  if (!d) throw new ApiError("Delivery not found", 404);
  if (d.status !== "funding") throw new ApiError(`Delivery is ${d.status}, expected funding`, 409);
  try {
    return ok(await checkBridge(d));
  } catch (e) {
    if (e instanceof ZentroNotConfiguredError) return fail(e.message, 503);
    throw e;
  }
});
