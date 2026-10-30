import { ok, requireApiSession, route } from "@/app/api/_lib";
import { ensureProtocolTreasury, protocolStats } from "@/lib/protocol";

/** Create the protocol treasury key (idempotent) and return the current stats. */
export const POST = route(async () => {
  await requireApiSession("admin");
  const address = await ensureProtocolTreasury();
  return ok({ address, stats: await protocolStats() }, { status: 201 });
});

export const GET = route(async () => {
  await requireApiSession("admin");
  return ok(await protocolStats());
});
