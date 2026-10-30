import { NextResponse } from "next/server";
import { fail } from "@/app/api/_lib";
import { beginGoogleLogin, GoogleNotConfiguredError } from "@/lib/auth/google";
import { safeNextPath } from "@/lib/auth/next-path";

/**
 * `GET /api/auth/google?next=/dashboard&scope=operator` → 302 to Google's consent screen.
 * `scope=operator` asks for Gmail (offline) on top of sign-in; anything else is plain OIDC.
 * 503 envelope when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET are unset.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const scope = url.searchParams.get("scope") === "operator" ? "operator" : "base";
  try {
    return NextResponse.redirect(await beginGoogleLogin({ next, scope }), 302);
  } catch (e) {
    if (e instanceof GoogleNotConfiguredError) return fail(e.message, 503);
    throw e;
  }
}
