import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for Next's request cookie jar. */
const jar = vi.hoisted(() => {
  const store: Record<string, string> = {};
  const opts: Record<string, { expires?: Date; httpOnly?: boolean }> = {};
  return {
    store,
    opts,
    get: (name: string) => (name in store ? { name, value: store[name] } : undefined),
    set: (name: string, value: string, o: { expires?: Date; httpOnly?: boolean } = {}) => {
      store[name] = value;
      opts[name] = o;
    },
    delete: (name: string) => {
      delete store[name];
      delete opts[name];
    },
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
      for (const k of Object.keys(opts)) delete opts[k];
    },
  };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
/** What Google's token endpoint "returns" to the callback: no network. */
const google = vi.hoisted(() => ({ identity: { sub: "", email: "", emailVerified: true, name: null as string | null, picture: null as string | null } }));
vi.mock("@/lib/auth/google", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleModule>()),
  exchangeCode: async () => ({ identity: google.identity, accessToken: "at", refreshToken: null, scopes: [] }),
}));

import type * as GoogleModule from "@/lib/auth/google";
import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { db, schema } from "@/lib/db";
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "@/lib/auth/google";
import { safeNextPath } from "@/lib/auth/next-path";
import { createSession, getSession, revokeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { upsertGoogleUser } from "@/lib/auth/users";

const DAY = 86_400_000;
const req = (h: Record<string, string> = {}) => new Request("http://localhost/api/auth/google/callback", { headers: h });

async function sessionRow() {
  const id = jar.store[SESSION_COOKIE].split(".")[0];
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get())!;
}

describe("sessions", () => {
  const userId = "usr_alice";
  beforeEach(async () => {
    jar.reset();
    await db.delete(schema.sessions);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.insert(schema.users).values({ id: userId, googleSub: "sub-alice", email: "alice@test.local", walletAddress: "AliceWallet", createdAt: new Date(), lastLoginAt: new Date() });
  });

  it("createSession sets an httpOnly cookie whose secret is only stored hashed", async () => {
    await createSession(userId, req({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    const cookie = jar.store[SESSION_COOKIE];
    expect(cookie).toMatch(/^ses_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(jar.opts[SESSION_COOKIE].httpOnly).toBe(true);
    const row = await sessionRow();
    expect(row.userId).toBe(userId);
    expect(row.ip).toBe("203.0.113.9");
    expect(row.userAgent).toBe("vitest");
    expect(cookie).not.toContain(row.tokenHash);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);

    const s = await getSession();
    expect(s?.user.id).toBe(userId);
  });

  it("rejects a tampered secret and an unknown session id", async () => {
    await createSession(userId, req());
    const [id, secret] = jar.store[SESSION_COOKIE].split(".");
    const flipped = (secret[0] === "A" ? "B" : "A") + secret.slice(1);
    jar.set(SESSION_COOKIE, `${id}.${flipped}`);
    expect(await getSession()).toBeNull();
    jar.set(SESSION_COOKIE, `ses_doesnotexist00.${secret}`);
    expect(await getSession()).toBeNull();
    jar.set(SESSION_COOKIE, "garbage");
    expect(await getSession()).toBeNull();
    jar.delete(SESSION_COOKIE);
    expect(await getSession()).toBeNull();
  });

  it("honours expiry", async () => {
    await createSession(userId, req());
    const row = await sessionRow();
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.id, row.id));
    expect(await getSession()).toBeNull();
  });

  it("revokeSession clears the cookie and the row stays dead even if the cookie is replayed", async () => {
    await createSession(userId, req());
    const cookie = jar.store[SESSION_COOKIE];
    await revokeSession();
    expect(jar.store[SESSION_COOKIE]).toBeUndefined();
    jar.set(SESSION_COOKIE, cookie);
    expect(await getSession()).toBeNull();
    const row = await sessionRow();
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it("slides the expiry to a full TTL only when under 15 days remain", async () => {
    await createSession(userId, req());
    const row = await sessionRow();
    const cookie = jar.store[SESSION_COOKIE];

    const fresh = new Date(Date.now() + 20 * DAY);
    await db.update(schema.sessions).set({ expiresAt: fresh }).where(eq(schema.sessions.id, row.id));
    expect((await getSession())?.user.id).toBe(userId);
    expect((await sessionRow()).expiresAt.getTime()).toBe(fresh.getTime());

    const stale = new Date(Date.now() + 10 * DAY);
    await db.update(schema.sessions).set({ expiresAt: stale }).where(eq(schema.sessions.id, row.id));
    expect((await getSession())?.user.id).toBe(userId);
    const extended = (await sessionRow()).expiresAt.getTime();
    expect(extended - Date.now()).toBeGreaterThan(29 * DAY);
    expect(jar.store[SESSION_COOKIE]).toBe(cookie);
    expect(jar.opts[SESSION_COOKIE].expires?.getTime()).toBe(extended);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("  /ops?d=dlv_1#top ")).toBe("/ops?d=dlv_1#top");
    expect(safeNextPath("/")).toBe("/");
  });

  it("falls back to / for anything that could leave the origin or smuggle headers", () => {
    for (const bad of ["//evil.com", "//evil.com/x", "/\\evil.com", "javascript:alert(1)", "https://evil.com", "http://evil.com/", "evil.com", "dashboard", "/a\nb", "/a\rSet-Cookie: x", "/a\u0000", "/a\u007f", "", null, undefined, "/" + "x".repeat(2048)]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBe("/");
    }
  });
});

describe("upsertGoogleUser roles", () => {
  const identity = (sub: string, email: string) => ({ sub, email, emailVerified: true, name: "N", picture: null });

  it("assigns operator/admin from the allow-lists (case-insensitive on both sides) and user otherwise", async () => {
    expect((await upsertGoogleUser(identity("s1", "ops@test.local"))).role).toBe("operator");
    expect((await upsertGoogleUser(identity("s2", "second.op@test.local"))).role).toBe("operator");
    expect((await upsertGoogleUser(identity("s3", "Admin@Test.Local"))).role).toBe("admin");
    const plain = await upsertGoogleUser(identity("s4", "someone@test.local"));
    expect(plain.role).toBe("user");
    expect(plain.walletAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("never demotes: a listed role survives leaving the list, an existing admin survives an operator listing", async () => {
    const op = await upsertGoogleUser(identity("s1", "ops-personal@test.local"));
    expect(op.email).toBe("ops-personal@test.local");
    expect(op.role).toBe("operator");

    await db.insert(schema.users).values({ id: "usr_root", googleSub: "s6", email: "root@test.local", walletAddress: "RootWallet", role: "admin", createdAt: new Date(), lastLoginAt: new Date() });
    expect((await upsertGoogleUser(identity("s6", "ops@test.local"))).role).toBe("admin");
  });

  it("promotes an existing user whose account is now listed, keeping the same row", async () => {
    const before = (await db.select().from(schema.users).where(eq(schema.users.googleSub, "s4")).get())!;
    expect(before.role).toBe("user");
    await db.update(schema.users).set({ email: "root@test.local" }).where(eq(schema.users.id, "usr_root"));
    const after = await upsertGoogleUser(identity("s4", "ops@test.local"));
    expect(after.id).toBe(before.id);
    expect(after.role).toBe("operator");
  });

  it("adopts a row provisioned by email on the first verified sign-in, keeping its wallet and role", async () => {
    await db.insert(schema.users).values({ id: "usr_seeded", googleSub: "pending:seeded", email: "seeded@test.local", walletAddress: "SeededWallet", role: "operator", createdAt: new Date(), lastLoginAt: new Date() });
    const adopted = await upsertGoogleUser(identity("s8", "seeded@test.local"));
    expect(adopted.id).toBe("usr_seeded");
    expect(adopted.googleSub).toBe("s8");
    expect(adopted.role).toBe("operator");
    expect(adopted.walletAddress).toBe("SeededWallet");
    expect((await db.select().from(schema.users).where(eq(schema.users.email, "seeded@test.local"))).length).toBe(1);
  });

  it("refuses to hand a row that a Google account already signed into to another account with the same email", async () => {
    const owner = await upsertGoogleUser(identity("s9", "reassigned@test.local"));
    await createSession(owner.id, req());
    await expect(upsertGoogleUser(identity("s10", "reassigned@test.local"))).rejects.toThrow(/different Google account/);
    const row = (await db.select().from(schema.users).where(eq(schema.users.id, owner.id)).get())!;
    expect(row.googleSub).toBe("s9");
    expect(row.walletAddress).toBe(owner.walletAddress);
  });
});

describe("Google callback", () => {
  it("refuses an identity whose email Google has not verified: no user row, no session, auth_error on the redirect", async () => {
    jar.reset();
    // A provisioned admin row that an unverified claim to the same email must not adopt.
    await db.insert(schema.users).values({ id: "usr_admin_seat", googleSub: "pending:admin", email: "admin@test.local", walletAddress: "AdminSeatWallet", role: "admin", createdAt: new Date(), lastLoginAt: new Date() });
    google.identity = { sub: "s_unverified", email: "admin@test.local", emailVerified: false, name: "Mallory", picture: null };
    jar.set(OAUTH_STATE_COOKIE, JSON.stringify({ state: "st", next: "/dashboard", client: "signin" }));
    jar.set(OAUTH_VERIFIER_COOKIE, "verifier");

    const res = await googleCallback(new Request("http://localhost/api/auth/google/callback?code=c&state=st"));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/dashboard");
    expect(to.searchParams.get("auth_error")).toBe("unverified");
    expect(jar.store[SESSION_COOKIE]).toBeUndefined();
    expect(await db.select().from(schema.users).where(eq(schema.users.googleSub, "s_unverified"))).toEqual([]);
    expect((await db.select().from(schema.users).where(eq(schema.users.id, "usr_admin_seat")).get())!.googleSub).toBe("pending:admin");

    // The same account once Google verifies the email signs in and takes the seat.
    google.identity = { ...google.identity, emailVerified: true };
    jar.set(OAUTH_STATE_COOKIE, JSON.stringify({ state: "st2", next: "/dashboard", client: "signin" }));
    jar.set(OAUTH_VERIFIER_COOKIE, "verifier");
    const ok = await googleCallback(new Request("http://localhost/api/auth/google/callback?code=c&state=st2"));
    expect(new URL(ok.headers.get("location")!).searchParams.get("auth_error")).toBeNull();
    expect(jar.store[SESSION_COOKIE]).toBeDefined();
  });
});
