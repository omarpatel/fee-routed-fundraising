import { z } from "zod";
import { fail, ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { importBrowserSession, ZentroNotConfiguredError, zentroStatus } from "@/lib/zentro/session-store";

const Jwk = z.object({ kty: z.string(), crv: z.string(), x: z.string(), d: z.string().optional(), kid: z.string().optional() }).passthrough();
/** Accept either parsed JWK objects or the raw localStorage strings. */
const JwkInput = z.union([Jwk, z.string().transform((s, ctx) => {
  try {
    return Jwk.parse(JSON.parse(s));
  } catch {
    ctx.addIssue({ code: "custom", message: "not a JWK JSON string" });
    return z.NEVER;
  }
})]);
const Body = z.object({ cookie: z.string().min(1), privateJwk: JwkInput, publicJwk: JwkInput, serverJwk: JwkInput });

/** Store a CardHub session copied from the operator's browser, then probe it. Admin only. */
export const POST = route(async (req) => {
  await requireApiSession("admin");
  const body = await parseBody(req, Body);
  try {
    await importBrowserSession(body);
  } catch (e) {
    if (e instanceof ZentroNotConfiguredError) return fail(e.message, 503);
    return fail(e instanceof Error ? e.message : String(e), 400);
  }
  return ok(await zentroStatus({ probe: true }));
});
