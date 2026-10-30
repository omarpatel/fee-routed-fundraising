import { NextResponse } from "next/server";
import { ok } from "@/app/api/_lib";
import { hasGoogleTokens } from "@/lib/auth/google";
import { getSession, revokeSession } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";

/** Current session user with `gmailConnected`, or null when signed out. Sliding expiry is applied here. */
export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return ok<SessionUser | null>(null);
  const gmailConnected = await hasGoogleTokens(session.user.id);
  return ok<SessionUser>({ ...session.user, gmailConnected });
}

/** Sign out: revoke the session row and clear the cookie. */
export async function DELETE(): Promise<NextResponse> {
  await revokeSession();
  return ok(null);
}
