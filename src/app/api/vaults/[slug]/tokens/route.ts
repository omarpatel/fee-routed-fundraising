import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ApiError, assertVaultOwner, httpUrl, ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { TOKEN_SOURCES, tokens, vaults } from "@/lib/db/schema";
import { connectToken } from "@/lib/ledger";
import { isStoredImageUrl } from "@/lib/uploads";

const Body = z.object({
  mint: z.string().min(32).max(44),
  symbol: z.string().min(1).max(12),
  name: z.string().min(1).max(64),
  /** From POST /api/uploads (kind token); re-checked against the image store below. */
  imageUrl: z.string().nullish(),
  source: z.enum(TOKEN_SOURCES),
  launchpadUrl: httpUrl.nullish(),
  creatorWallet: z.string().min(32).max(44).nullish(),
  routeBps: z.number().int().min(1).max(10000).optional(),
});

async function vaultBySlug(slug: string) {
  const v = await db.select().from(vaults).where(eq(vaults.slug, slug)).get();
  if (!v) throw new ApiError("Vault not found", 404);
  return v;
}

/** The vault's live token connections; superseded ones are history, not connections. */
export const GET = route<{ slug: string }>(async (_req, { slug }) => {
  const v = await vaultBySlug(slug);
  return ok(await db.select().from(tokens).where(and(eq(tokens.vaultId, v.id), isNull(tokens.supersededAt))));
});

/** Connect an existing token: mints a dedicated route address the creator points fees at. */
export const POST = route<{ slug: string }>(async (req, { slug }) => {
  const session = await requireApiSession();
  const v = await vaultBySlug(slug);
  assertVaultOwner(session, v);
  const body = await parseBody(req, Body);
  if (body.imageUrl && !isStoredImageUrl(body.imageUrl)) throw new ApiError("Token image must be uploaded through /api/uploads first", 400);
  return ok(await connectToken({ ...body, vaultId: v.id }), { status: 201 });
});
