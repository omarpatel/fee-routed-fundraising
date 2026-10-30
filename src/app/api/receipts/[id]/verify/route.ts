import { fail, ok, route } from "@/app/api/_lib";
import { getReceipt } from "@/lib/db/queries";
import { canonicalReceipt, verifyAnchorOnChain, verifyReceipt } from "@/lib/proof";

/** Public: recompute the receipt hash and, when anchored, check the on-chain memo. */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const r = await getReceipt(id);
  if (!r) return fail("Receipt not found", 404);
  if (r.delivery.status !== "delivered") return fail(`Delivery is ${r.delivery.status}; no receipt yet`, 409);
  const local = verifyReceipt(r);
  const onchain = r.delivery.anchorTxSig ? await verifyAnchorOnChain(r.delivery) : null;
  const includeCanonical = new URL(req.url).searchParams.get("canonical") === "1";
  return ok({ ...local, onchain, canonical: includeCanonical ? canonicalReceipt(r) : undefined });
});
