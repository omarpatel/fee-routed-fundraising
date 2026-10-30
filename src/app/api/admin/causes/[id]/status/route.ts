import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { causes } from "@/lib/db/schema";

const Body = z
  .object({
    status: z.enum(["pending", "verified", "rejected"]),
    note: z.string().max(2000).default(""),
  })
  .refine((b) => b.status !== "verified" || b.note.trim().length >= 10, { path: ["note"], message: "a written note (10+ chars) is required to verify" });

/** The human decision. Operator or admin; the reviewer's identity and time are written into the note. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const { user } = await requireApiSession("operator");
  const body = await parseBody(req, Body);
  const cause = await db.select({ id: causes.id }).from(causes).where(eq(causes.id, id)).get();
  if (!cause) throw new ApiError("Cause not found", 404);
  const who = user.name ?? user.email ?? user.id;
  const note = body.note.trim() ? `${body.note.trim()} — ${who}, ${new Date().toISOString().slice(0, 10)}` : null;
  const [updated] = await db
    .update(causes)
    .set({ verificationStatus: body.status, verificationNote: note, verifiedAt: body.status === "verified" ? new Date() : null })
    .where(eq(causes.id, id))
    .returning();
  return ok(updated);
});
