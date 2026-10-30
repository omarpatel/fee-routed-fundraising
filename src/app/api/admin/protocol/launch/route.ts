import { z } from "zod";
import { fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { withLock } from "@/lib/ledger/locks";
import { launchProtocolToken } from "@/lib/protocol";
import { PROTOCOL_DEFAULT_DEV_BUY_SOL } from "@/lib/protocol/token";
import { readImageByUrl, UploadError } from "@/lib/uploads";

const Body = z.object({
  description: z.string().min(1).max(1000),
  /** From POST /api/uploads (kind token). */
  imageUrl: z.string().startsWith("/api/files/images/", "upload the image first"),
  devBuySol: z.number().min(0).max(50).default(PROTOCOL_DEFAULT_DEV_BUY_SOL),
  /** The operator must state they understand this deploys on mainnet. */
  confirmMainnet: z.literal(true),
});

/** Launch $ROUTE on pump.fun with the protocol treasury as creator, paid by the calling admin's custodial wallet. One-shot; refuses once `protocol_mint` is set. */
export const POST = route(async (req) => {
  const { user } = await requireApiSession("admin");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === "confirmMainnet")) return fail("Tick the mainnet confirmation before launching", 400);
    return fail(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 400);
  }
  let image;
  try {
    image = await readImageByUrl(parsed.data.imageUrl);
  } catch (e) {
    if (e instanceof UploadError) return fail(e.message, e.status);
    throw e;
  }
  // One-shot: a double submit must see the first launch's `protocol_mint` instead of racing past the check and minting twice.
  const result = await withLock("protocol:fee-router-launch", () => launchProtocolToken({ description: parsed.data.description, imageUrl: parsed.data.imageUrl, image, devBuySol: parsed.data.devBuySol, payerUserId: user.id }));
  return ok(result, { status: 201 });
});
