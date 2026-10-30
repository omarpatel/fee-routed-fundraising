import { fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { configured } from "@/lib/env";
import { watchedAddresses } from "@/lib/ledger/ingest";
import { ensureWebhook } from "@/lib/solana/helius";

/** Register or update the Helius webhook for every token route address plus the protocol treasury. */
export const POST = route(async () => {
  await requireApiSession("admin");
  if (!configured.helius) return fail("Helius not configured (HELIUS_API_KEY + HELIUS_WEBHOOK_SECRET)", 503);
  const addresses = await watchedAddresses();
  if (addresses.length === 0) return fail("Nothing to watch yet: no token routes and no protocol treasury", 409);
  const webhookId = await ensureWebhook(addresses);
  return ok({ webhookId, addresses: addresses.length });
});
