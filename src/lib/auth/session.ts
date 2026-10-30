import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createHmac, randomBytes } from "node:crypto";
import { cache } from "react";
import { db, schema } from "@/lib/db";
import type { User } from "@/lib/db/schema";
import { env } from "@/lib/env";

/** httpOnly cookie `<sessionId>.<secret>`. Set by the Google callback, cleared by DELETE /api/auth/session. */
export const SESSION_COOKIE = "fee_router_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding window: a session touched with less than this left is extended to a full TTL. */
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

export type Session = { user: User };

/**
 * HMAC-SHA256(SESSION_SECRET, secret). The DB holds only this, so a leaked table cannot mint cookies;
 * rotating SESSION_SECRET signs everyone out. Null when SESSION_SECRET is unset (no cookie sessions).
 */
function hashToken(secret: string): string | null {
  if (!env.SESSION_SECRET) return null;
  return createHmac("sha256", env.SESSION_SECRET).update(secret).digest("hex");
}

function cookieOptions(expires: Date) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", expires };
}

/** Write the cookie when the caller is a Route Handler / Server Action; Server Components cannot set cookies. */
async function trySetCookie(value: string, expires: Date): Promise<void> {
  try {
    (await cookies()).set(SESSION_COOKIE, value, cookieOptions(expires));
  } catch {
    // Rendering context: the DB row already carries the new expiry; the cookie catches up on the next API call.
  }
}

/** Open a session for `userId` and set the cookie. Requires SESSION_SECRET. */
export async function createSession(userId: string, req: Request): Promise<void> {
  const secret = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(secret);
  if (!tokenHash) throw new Error("SESSION_SECRET is not configured");
  const id = `ses_${nanoid(16)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    id,
    userId,
    tokenHash,
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    ip: (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip"))?.trim().slice(0, 64) ?? null,
    createdAt: now,
    expiresAt,
  });
  (await cookies()).set(SESSION_COOKIE, `${id}.${secret}`, cookieOptions(expiresAt));
}

/** Mark the cookie's session revoked and clear the cookie. No-op when signed out. */
export async function revokeSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  if (!raw) return;
  const dot = raw.indexOf(".");
  if (dot <= 0) return;
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.id, raw.slice(0, dot)), isNull(schema.sessions.revokedAt)));
}

/**
 * Current signed-in user, or null. Splits the cookie, checks the HMAC against `sessions.tokenHash`,
 * rejects expired/revoked rows, slides the expiry when under 15 days remain. Memoized per request.
 *
 * Local demo escape hatch: outside production, `FEE_ROUTER_DEV_SESSION_EMAIL` selects a seeded user
 * (`ops@example.com` after `pnpm db:seed`) so /dashboard and /ops render without Google.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const devEmail = process.env.NODE_ENV !== "production" ? env.FEE_ROUTER_DEV_SESSION_EMAIL?.trim().toLowerCase() : undefined;
  if (devEmail) {
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, devEmail) });
    return user ? { user } : null;
  }
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const tokenHash = hashToken(raw.slice(dot + 1));
  if (!tokenHash) return null;
  const row = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, raw.slice(0, dot)), eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt)))
    .get();
  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now) return null;
  if (row.session.expiresAt.getTime() - now < SESSION_RENEW_BELOW_MS) {
    const expiresAt = new Date(now + SESSION_TTL_MS);
    await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, row.session.id));
    await trySetCookie(raw, expiresAt);
  }
  return { user: row.user };
});

/** Session or bounce: signed out → `/?login=1` (starts Google sign-in); wrong role → 404. */
export async function requireSession(role?: "operator" | "admin"): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/?login=1");
  if (role === "admin" && session.user.role !== "admin") notFound();
  if (role === "operator" && session.user.role !== "operator" && session.user.role !== "admin") notFound();
  return session;
}
