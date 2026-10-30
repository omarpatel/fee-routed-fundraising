import { eq } from "drizzle-orm";
import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { deliveries } from "@/lib/db/schema";
import { LedgerError } from "@/lib/ledger";
import { RailNotConfiguredError, railById } from "@/lib/rails";

/**
 * Move treasury USDC onto the delivery's rail: a Zentro top-up invoice (→ `funding`) or the cause
 * wallet (→ `funded`). The rail claims the row atomically before sending, so a double click or a
 * concurrent worker tick gets a 409 rather than a second transfer, and it records the outcome of a
 * failed transfer itself (`failed`, or `funding` + signature when USDC may have moved).
 */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  await requireApiSession("operator");
  const d = await db.select().from(deliveries).where(eq(deliveries.id, id)).get();
  if (!d) throw new ApiError("Delivery not found", 404);
  if (d.status !== "queued") throw new ApiError(`Delivery is ${d.status}, expected queued`, 409);
  const rail = railById(d.rail);
  try {
    return ok(await rail.fund(d));
  } catch (e) {
    if (e instanceof RailNotConfiguredError) return fail(e.message, 503);
    if (e instanceof LedgerError) throw e;
    return fail(`Funding failed: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
});
