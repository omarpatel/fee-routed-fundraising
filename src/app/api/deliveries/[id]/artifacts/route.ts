import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { deliveries, receiptArtifacts } from "@/lib/db/schema";
import { attachArtifact } from "@/lib/ledger";
import { ArtifactError, storeArtifact } from "@/lib/ledger/artifacts";

const KINDS = ["screenshot", "confirmation_email", "card_statement", "platform_receipt", "onchain_tx", "other"] as const;
const Fields = z.object({ kind: z.enum(KINDS), label: z.string().min(1).max(120), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/) });

/** Artifacts are public once the receipt is sealed; while a delivery is in flight only operators may list them. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const d = await db.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.id, id)).get();
  if (!d) throw new ApiError("Delivery not found", 404);
  if (d.status !== "delivered") await requireApiSession("operator");
  return ok(await db.select().from(receiptArtifacts).where(eq(receiptArtifacts.deliveryId, id)).orderBy(receiptArtifacts.createdAt));
});

/**
 * multipart/form-data: `file`, `kind`, `label`, `sha256` (client-computed; must match the bytes).
 * Stores under data/uploads and records the artifact row. Operator only.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  await requireApiSession("operator");
  const form = await req.formData().catch(() => {
    throw new ApiError("Expected multipart/form-data", 400);
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError("Missing file", 400);
  const fields = Fields.parse({ kind: form.get("kind"), label: form.get("label"), sha256: form.get("sha256") });
  try {
    const stored = await storeArtifact(id, file, fields.sha256);
    const row = await attachArtifact(id, { kind: fields.kind, label: fields.label, url: stored.url, sha256: stored.sha256, bytes: stored.bytes });
    return ok(row, { status: 201 });
  } catch (e) {
    if (e instanceof ArtifactError) return fail(e.message, e.status);
    throw e;
  }
});
