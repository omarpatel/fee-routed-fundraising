import "server-only";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "@/lib/db";
import type { User } from "@/lib/db/schema";
import { adminEmails, operatorEmails } from "@/lib/env";
import { createUserWallet } from "@/lib/wallet";
import type { GoogleIdentity } from "./google";

/** Google did not verify the email on the ID token; the sign-in is refused before any row is touched. */
export class UnverifiedEmailError extends Error {
  constructor(email: string) {
    super(`Google has not verified ${email}; refusing sign-in`);
    this.name = "UnverifiedEmailError";
  }
}

/**
 * Upsert the `users` row for a Google identity, keyed by `sub`. Google only attests for `email`
 * when `email_verified` is set, so an unverified identity is refused outright: it could otherwise
 * occupy an allow-listed email before its owner signs in. A row that was provisioned by email (seed
 * operator, manual allow-list) is adopted on the first sign-in with that email, but only while no
 * Google account has ever signed into it: once a row has a session, its `sub` is the identity, and
 * a different Google account presenting the same (reassigned, recycled domain) email is refused
 * rather than handed the row and its custodial wallet. First sign-in otherwise mints the custodial
 * wallet (KMS required). Role: email in ADMIN_EMAILS → admin, in OPERATOR_EMAILS → operator; an
 * existing higher role is never demoted. Bumps `lastLoginAt`.
 */
export async function upsertGoogleUser(identity: GoogleIdentity): Promise<User> {
  if (!identity.emailVerified) throw new UnverifiedEmailError(identity.email);
  const now = new Date();
  let existing = await db.query.users.findFirst({ where: eq(schema.users.googleSub, identity.sub) });
  if (!existing) {
    const byEmail = await db.query.users.findFirst({ where: eq(schema.users.email, identity.email) });
    if (byEmail) {
      const signedIn = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, byEmail.id)).get();
      if (signedIn) throw new Error(`${identity.email} belongs to a different Google account (sub mismatch); refusing to re-bind ${byEmail.id}`);
      existing = byEmail;
    }
  }
  const email = identity.email.toLowerCase();
  const listed: User["role"] = adminEmails.has(email) ? "admin" : operatorEmails.has(email) ? "operator" : "user";
  const current = existing?.role ?? "user";
  const role: User["role"] = current === "admin" || listed === "admin" ? "admin" : current === "operator" || listed === "operator" ? "operator" : "user";

  if (existing) {
    const [row] = await db
      .update(schema.users)
      .set({
        googleSub: identity.sub,
        email: identity.email,
        emailVerified: identity.emailVerified,
        name: identity.name ?? existing.name,
        avatarUrl: identity.picture ?? existing.avatarUrl,
        role,
        lastLoginAt: now,
      })
      .where(eq(schema.users.id, existing.id))
      .returning();
    return row;
  }

  const id = `usr_${nanoid(12)}`;
  const walletAddress = await createUserWallet(id);
  const [row] = await db
    .insert(schema.users)
    .values({
      id,
      googleSub: identity.sub,
      email: identity.email,
      emailVerified: identity.emailVerified,
      name: identity.name,
      avatarUrl: identity.picture,
      walletAddress,
      role,
      createdAt: now,
      lastLoginAt: now,
    })
    .returning();
  return row;
}
