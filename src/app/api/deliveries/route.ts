import { desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { deliveries } from "@/lib/db/schema";
import { deliverable, queueDelivery } from "@/lib/ledger";

const Body = z.object({ vaultId: z.string().min(1), amountUsdc: z.number().positive().max(10_000_000) });

/** Operator desk: in-flight deliveries. */
export const GET = route(async () => {
  await requireApiSession("operator");
  return ok(await db.select().from(deliveries).where(inArray(deliveries.status, ["queued", "funding", "funded", "executing"])).orderBy(desc(deliveries.queuedAt)));
});

/** Queue min(amount, deliverable) with pro-rata token allocations. Operator only. */
export const POST = route(async (req) => {
  await requireApiSession("operator");
  const body = await parseBody(req, Body);
  const d = await queueDelivery(body.vaultId, body.amountUsdc);
  return ok({ delivery: d, deliverable: await deliverable(body.vaultId) }, { status: 201 });
});
