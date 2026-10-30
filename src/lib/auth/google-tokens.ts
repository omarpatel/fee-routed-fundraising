import { Google } from "arctic";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { configured, env } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/keys";

/**
 * Google OAuth client + refresh-token storage. No Next.js imports: `scripts/worker.ts` uses
 * `refreshAccessToken` for Gmail harvesting outside the request lifecycle.
 */

export const GOOGLE_REDIRECT_PATH = "/api/auth/google/callback";

/**
 * Two OAuth clients, one callback. `signin` is the published production client (openid/email/profile
 * only). `gmail` is a Testing-mode client allowed to request gmail.readonly/gmail.send for listed
 * operators; its refresh tokens are the ones stored in `googleTokens`.
 */
export type GoogleClientKind = "signin" | "gmail";

export class GoogleNotConfiguredError extends Error {
  constructor(kind: GoogleClientKind) {
    super(kind === "gmail" ? "Gmail client not configured — set GOOGLE_GMAIL_CLIENT_ID and GOOGLE_GMAIL_CLIENT_SECRET" : "Sign-in not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET");
    this.name = "GoogleNotConfiguredError";
  }
}

export class GoogleNotConnectedError extends Error {
  constructor(userId: string) {
    super(`No Google refresh token on file for ${userId}; connect Gmail from the account menu`);
    this.name = "GoogleNotConnectedError";
  }
}

export function googleProvider(kind: GoogleClientKind): Google {
  const redirect = new URL(GOOGLE_REDIRECT_PATH, env.NEXT_PUBLIC_SITE_URL).toString();
  if (kind === "gmail") {
    if (!configured.gmail) throw new GoogleNotConfiguredError("gmail");
    return new Google(env.GOOGLE_GMAIL_CLIENT_ID!, env.GOOGLE_GMAIL_CLIENT_SECRET!, redirect);
  }
  if (!configured.google) throw new GoogleNotConfiguredError("signin");
  return new Google(env.GOOGLE_CLIENT_ID!, env.GOOGLE_CLIENT_SECRET!, redirect);
}

/** Persist a refresh token (AES-256-GCM under FEE_ROUTER_KMS_KEY) so Gmail can be used without the user present. */
export async function storeRefreshToken(userId: string, refreshToken: string, scopes: readonly string[]): Promise<void> {
  const now = new Date();
  const refreshTokenEnc = encryptSecret(Buffer.from(refreshToken, "utf8"));
  await db
    .insert(schema.googleTokens)
    .values({ userId, refreshTokenEnc, scopes: scopes.join(" "), createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.googleTokens.userId, set: { refreshTokenEnc, scopes: scopes.join(" "), updatedAt: now } });
}

export async function hasGoogleTokens(userId: string): Promise<boolean> {
  const row = await db.select({ userId: schema.googleTokens.userId }).from(schema.googleTokens).where(eq(schema.googleTokens.userId, userId)).get();
  return !!row;
}

/**
 * Fresh Google access token for a user who connected Gmail. If Google says the grant is gone
 * (`invalid_grant`: revoked or expired), the stored token is dropped so the UI offers reconnect.
 */
export async function refreshAccessToken(userId: string): Promise<string> {
  const row = await db.query.googleTokens.findFirst({ where: eq(schema.googleTokens.userId, userId) });
  if (!row) throw new GoogleNotConnectedError(userId);
  const refreshToken = Buffer.from(decryptSecret(row.refreshTokenEnc)).toString("utf8");
  try {
    const tokens = await googleProvider("gmail").refreshAccessToken(refreshToken);
    return tokens.accessToken();
  } catch (e) {
    if (e instanceof Error && e.message.includes("invalid_grant")) {
      await db.delete(schema.googleTokens).where(eq(schema.googleTokens.userId, userId));
      throw new GoogleNotConnectedError(userId);
    }
    throw e;
  }
}
