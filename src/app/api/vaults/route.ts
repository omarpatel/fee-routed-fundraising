import { z } from "zod";
import { ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { listVaults } from "@/lib/db/queries";
import { createVault } from "@/lib/ledger";

const Body = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/, "lowercase letters, digits and hyphens"),
  name: z.string().min(2).max(80),
  tagline: z.string().max(140).nullish(),
  causeId: z.string().min(1),
  donateBps: z.number().int().min(1000).max(10000).optional(),
  deliveryThresholdUsd: z.number().min(10).max(1_000_000).optional(),
});

export const GET = route(async () => ok(await listVaults({ limit: 100 })));

export const POST = route(async (req) => {
  const { user } = await requireApiSession();
  const body = await parseBody(req, Body);
  return ok(await createVault({ ...body, ownerUserId: user.id }), { status: 201 });
});
