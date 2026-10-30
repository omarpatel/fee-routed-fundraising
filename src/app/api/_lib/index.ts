import { NextResponse } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { getSession, type Session } from "@/lib/auth/session";
import type { Vault } from "@/lib/db/schema";
import { LedgerError } from "@/lib/ledger";

/** JSON envelope: `{ ok: true, data }` | `{ ok: false, error }`. */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(error: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Absolute http(s) URL. `z.url()` alone accepts `javascript:` and friends, which get rendered as hrefs. */
export const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RouteContext<P> = { params: Promise<P> };
type Handler<P> = (req: Request, params: P) => Promise<NextResponse>;

/** Wrap a route: resolves params, maps LedgerError/ApiError/ZodError to the envelope, 500 otherwise. */
export function route<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: Request, ctx: RouteContext<P>): Promise<NextResponse> => {
    try {
      return await handler(req, await ctx.params);
    } catch (e) {
      if (e instanceof ApiError || e instanceof LedgerError) return fail(e.message, e.status);
      if (e instanceof ZodError) return fail(e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 400);
      // Upstream error bodies (RPC, Helius, Jupiter, libsql) stay in the log; the client gets a handle to quote.
      const requestId = crypto.randomUUID();
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} request ${requestId}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      return NextResponse.json({ ok: false, error: "Internal error", requestId }, { status: 500 });
    }
  };
}

/** Session for API routes: JSON 401/403 instead of the page-oriented redirect/notFound. */
export async function requireApiSession(role?: "operator" | "admin"): Promise<Session> {
  const session = await getSession();
  if (!session) throw new ApiError("Unauthorized", 401);
  const r = session.user.role;
  if (role === "admin" && r !== "admin") throw new ApiError("Forbidden", 403);
  if (role === "operator" && r !== "operator" && r !== "admin") throw new ApiError("Forbidden", 403);
  return session;
}

export function assertVaultOwner(session: Session, vault: Pick<Vault, "ownerUserId">): void {
  const u = session.user;
  if (u.role === "operator" || u.role === "admin") return;
  if (vault.ownerUserId !== u.id) throw new ApiError("Forbidden", 403);
}

/**
 * Per-key sliding-window limiter; `take(key)` records an attempt and returns false once `max` fell
 * inside the last `windowMs`. In-memory on purpose: one Next process serves this app; a
 * multi-instance deploy would need the counter moved to the DB or a KV.
 */
export function rateLimiter(windowMs: number, max: number): { take(key: string): boolean } {
  const attempts = new Map<string, number[]>();
  return {
    take(key) {
      const now = Date.now();
      const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        attempts.set(key, recent);
        return false;
      }
      recent.push(now);
      attempts.set(key, recent);
      return true;
    },
  };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw: unknown = await req.json().catch(() => {
    throw new ApiError("Body must be JSON", 400);
  });
  return schema.parse(raw);
}
