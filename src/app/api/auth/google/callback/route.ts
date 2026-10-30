import { NextResponse } from "next/server";
import { fail } from "@/app/api/_lib";
import { exchangeCode, GoogleNotConfiguredError, storeRefreshToken, takeOAuthCookies } from "@/lib/auth/google";
import { createSession } from "@/lib/auth/session";
import { UnverifiedEmailError, upsertGoogleUser } from "@/lib/auth/users";
import { env } from "@/lib/env";
import { KmsNotConfiguredError } from "@/lib/keys";

/** Send the user back where they were going, with `auth_error=<code>` when the sign-in did not complete. */
function back(next: string, authError?: string): NextResponse {
  const url = new URL(next, env.NEXT_PUBLIC_SITE_URL);
  if (authError) url.searchParams.set("auth_error", authError);
  return NextResponse.redirect(url, 302);
}

/**
 * `GET /api/auth/google/callback?code&state` — second leg of the PKCE flow.
 * Checks `state` against the handshake cookie, redeems the code, validates the ID token,
 * upserts the user (custodial wallet on first sign-in), stores the Gmail refresh token when
 * the operator tier was requested, opens a session, and redirects to the sanitized `next`.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const handshake = await takeOAuthCookies();
  if (!handshake) return back("/", "expired");
  if (params.get("error")) return back(handshake.next, params.get("error") === "access_denied" ? "cancelled" : "google");
  const code = params.get("code");
  if (!code || params.get("state") !== handshake.state) return back(handshake.next, "state");

  try {
    const result = await exchangeCode(code, handshake.codeVerifier, handshake.client);
    const user = await upsertGoogleUser(result.identity);
    // Sign-in succeeded regardless; a missing Gmail grant is reported, not fatal.
    const gmailGranted = handshake.client !== "gmail" || (result.refreshToken !== null && result.scopes.some((s) => s.includes("gmail")));
    if (handshake.client === "gmail" && gmailGranted) await storeRefreshToken(user.id, result.refreshToken!, result.scopes);
    await createSession(user.id, req);
    return back(handshake.next, gmailGranted ? undefined : "gmail");
  } catch (e) {
    if (e instanceof GoogleNotConfiguredError || e instanceof KmsNotConfiguredError) return fail(e.message, 503);
    if (e instanceof UnverifiedEmailError) return back(handshake.next, "unverified");
    console.error(`[auth] google callback: ${e instanceof Error ? e.message : String(e)}`);
    return back(handshake.next, "exchange");
  }
}
