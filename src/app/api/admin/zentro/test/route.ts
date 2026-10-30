import { ok, requireApiSession, route } from "@/app/api/_lib";
import { zentroStatus } from "@/lib/zentro/session-store";

/** Live probe: state + card + balance. Persists last4 / lastOkAt / lastError. Admin only. */
export const POST = route(async () => {
  await requireApiSession("admin");
  return ok(await zentroStatus({ probe: true }));
});
