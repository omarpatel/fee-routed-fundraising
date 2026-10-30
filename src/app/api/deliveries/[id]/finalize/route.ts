import { z } from "zod";
import { ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { getReceipt } from "@/lib/db/queries";
import { finalizeDelivery } from "@/lib/ledger";
import { verifyReceipt } from "@/lib/proof";

const Body = z.object({
  railRef: z.string().min(1).max(200).nullish(),
  amountFiat: z.number().positive().nullish(),
  fiatCurrency: z.string().length(3).toUpperCase().nullish(),
  fxRate: z.number().positive().nullish(),
  platformFeeFiat: z.number().nonnegative().nullish(),
  notes: z.string().max(2000).nullish(),
});

/** Seal the receipt: hash, anchor, mark delivered. Returns the delivery plus a fresh verification. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const { user } = await requireApiSession("operator");
  const body = await parseBody(req, Body);
  const delivery = await finalizeDelivery(id, { ...body, executedByUserId: user.id });
  const receipt = (await getReceipt(id))!;
  return ok({ delivery, verification: verifyReceipt(receipt) });
});
