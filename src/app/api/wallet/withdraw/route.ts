import { z } from "zod";
import { fail, ok, parseBody, rateLimiter, requireApiSession, route } from "@/app/api/_lib";
import { assetDecimals, findWithdrawal, uiToRaw, WalletError, withdraw } from "@/lib/wallet";

const Body = z.object({
  /** `"SOL"` or an SPL mint address. */
  mint: z.string().min(1).max(64),
  /** UI units as a decimal string or number, e.g. "1.5". */
  amount: z.union([z.string().min(1), z.number().positive()]).transform((v) => (typeof v === "number" ? v.toString() : v)),
  to: z.string().min(32).max(64),
  /** Client-generated once per withdraw intent and reused on retry; a repeat returns the first transfer instead of sending again. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "16-64 url-safe characters"),
});

const RATE_MAX = 5;
/** Per-user withdrawal attempts in the last 10 minutes. A retry of an already recorded intent is not an attempt. */
const withdrawals = rateLimiter(10 * 60_000, RATE_MAX);

/** Send from the user's custodial wallet. Returns the `walletTransfers` row in its settled state (`confirmed`, or `failed` with `error`). */
export const POST = route(async (req) => {
  const { user } = await requireApiSession();
  const body = await parseBody(req, Body);
  // A lost response must stay recoverable after the limit is spent: withdraw() answers a known key from the ledger (or 409s a changed intent) and sends nothing.
  const retry = (await findWithdrawal(user.id, body.idempotencyKey)) !== null;
  if (!retry && !withdrawals.take(user.id)) return fail(`At most ${RATE_MAX} withdrawals per 10 minutes`, 429);
  try {
    const decimals = await assetDecimals(body.mint);
    const amountRaw = uiToRaw(body.amount, decimals).toString();
    const transfer = await withdraw(user.id, { mint: body.mint, amountRaw, to: body.to, idempotencyKey: body.idempotencyKey });
    return ok(transfer, { status: 201 });
  } catch (e) {
    if (e instanceof WalletError) return fail(e.message, e.status);
    throw e;
  }
});
