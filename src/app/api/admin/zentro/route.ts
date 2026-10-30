import { ok, requireApiSession, route } from "@/app/api/_lib";
import { zentroStatus } from "@/lib/zentro/session-store";

/** Stored-session state without a live probe unless `?probe=1`. Admin only. */
export const GET = route(async (req) => {
  await requireApiSession("admin");
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  return ok(await zentroStatus({ probe }));
});
