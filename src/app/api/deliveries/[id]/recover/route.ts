import { z } from "zod";
import { ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { recoverStrandedFunding } from "@/lib/ledger";

const Body = z.object({
  txSig: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "a base58 Solana transaction signature"),
});

/** Stranded funding returned to the treasury: verified on-chain, then released back to the deliverable balance. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const { user } = await requireApiSession("operator");
  const { txSig } = await parseBody(req, Body);
  return ok({ delivery: await recoverStrandedFunding(id, { txSig, operatorUserId: user.id }) });
});
