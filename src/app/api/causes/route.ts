import { z } from "zod";
import { ApiError, httpUrl, ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { CAUSE_PLATFORMS } from "@/lib/db/schema";
import { listCauses } from "@/lib/db/queries";
import { isStoredImageUrl } from "@/lib/uploads";
import { createCause } from "@/lib/ledger";

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/, "lowercase letters, digits and hyphens");

const Body = z.object({
  slug,
  title: z.string().min(3).max(120),
  summary: z.string().min(10).max(280),
  story: z.string().min(20).max(20_000),
  beneficiary: z.string().min(2).max(120),
  platform: z.enum(CAUSE_PLATFORMS),
  url: httpUrl,
  onchainAddress: z.string().min(32).max(44).nullish(),
  goalUsd: z.number().positive().nullish(),
  raisedExternalUsd: z.number().nonnegative().nullish(),
  currency: z.string().length(3).optional(),
  /** From POST /api/uploads (kind cause); re-checked against the image store below. */
  imageUrl: z.string().nullish(),
  location: z.string().max(120).nullish(),
  category: z.string().max(40).optional(),
});

export const GET = route(async () => ok(await listCauses()));

export const POST = route(async (req) => {
  const { user } = await requireApiSession();
  const body = await parseBody(req, Body);
  if (body.imageUrl && !isStoredImageUrl(body.imageUrl)) throw new ApiError("Cover image must be uploaded through /api/uploads first", 400);
  return ok(await createCause({ ...body, createdBy: user.id }), { status: 201 });
});
