import { eq } from "drizzle-orm";
import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { AiNotConfiguredError } from "@/lib/ai/claude";
import { checkFundraiser, readFundraiserBrief } from "@/lib/ai/fundraiser";
import { db } from "@/lib/db";
import { causes } from "@/lib/db/schema";
import { configured } from "@/lib/env";

/** The stored brief for a cause (null when never run), plus whether a run is possible. Operator or admin. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  await requireApiSession("operator");
  const cause = await db.select({ id: causes.id }).from(causes).where(eq(causes.id, id)).get();
  if (!cause) throw new ApiError("Cause not found", 404);
  return ok({ brief: await readFundraiserBrief(id), configured: configured.claude });
});

/** (Re)run the fact check. Assistive: writes the brief file, never touches `verificationStatus`. */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  await requireApiSession("operator");
  const cause = await db.select().from(causes).where(eq(causes.id, id)).get();
  if (!cause) throw new ApiError("Cause not found", 404);
  try {
    return ok(await checkFundraiser(cause));
  } catch (e) {
    if (e instanceof AiNotConfiguredError) return fail(e.message, e.status);
    throw e;
  }
});
