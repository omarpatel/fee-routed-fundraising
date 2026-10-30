import { eq } from "drizzle-orm";
import type { JWK } from "jose";
import { db } from "@/lib/db";
import { zentroSessions } from "@/lib/db/schema";
import { configured, env } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/keys";
import { ZentroClient, ZentroError, type ZentroCredentials, type ZentroSession } from "./client";

/**
 * Persistent Zentro session. One row (`default`) holds the CardHub cookie + client X25519 key pair,
 * AES-256-GCM under FEE_ROUTER_KMS_KEY (same envelope as custodial keys). The row is seeded either by
 * the operator importing a browser session from /admin, or by the client logging in with
 * ZENTRO_USERNAME / ZENTRO_PASSWORD; renewed sessions are written back through `onSession`.
 */

const ROW_ID = "default";

export class ZentroNotConfiguredError extends Error {
  readonly status = 503 as const;
  constructor(what: string) {
    super(`Zentro not configured: ${what}`);
    this.name = "ZentroNotConfiguredError";
  }
}

export function zentroCredentials(): ZentroCredentials | null {
  return configured.zentroLogin ? { username: env.ZENTRO_USERNAME!, password: env.ZENTRO_PASSWORD! } : null;
}

async function loadRow() {
  return db.select().from(zentroSessions).where(eq(zentroSessions.id, ROW_ID)).get();
}

async function upsert(patch: Partial<typeof zentroSessions.$inferInsert> & { sessionEnc?: string }): Promise<void> {
  const now = new Date();
  const existing = await loadRow();
  if (existing) {
    await db.update(zentroSessions).set({ ...patch, updatedAt: now }).where(eq(zentroSessions.id, ROW_ID));
    return;
  }
  if (!patch.sessionEnc) return; // nothing to record against until a session exists
  await db.insert(zentroSessions).values({ id: ROW_ID, sessionEnc: patch.sessionEnc, cardId: patch.cardId ?? null, last4: patch.last4 ?? null, lastOkAt: patch.lastOkAt ?? null, lastError: patch.lastError ?? null, updatedAt: now });
}

function encodeSession(s: ZentroSession): string {
  return encryptSecret(Buffer.from(JSON.stringify(s), "utf8"));
}

async function persistSession(s: ZentroSession): Promise<void> {
  await upsert({ sessionEnc: encodeSession(s), lastError: null });
}

/**
 * Client backed by the stored session. Throws `ZentroNotConfiguredError` when there is nothing to
 * work with: no KMS key, or neither an imported session nor login credentials.
 */
export async function getZentroClient(): Promise<ZentroClient> {
  if (!configured.kms) throw new ZentroNotConfiguredError("FEE_ROUTER_KMS_KEY");
  const row = await loadRow();
  let session: ZentroSession | null = null;
  if (row) {
    try {
      session = JSON.parse(Buffer.from(decryptSecret(row.sessionEnc)).toString("utf8")) as ZentroSession;
    } catch {
      // Row encrypted under a previous KMS key: unusable, fall through to credentials.
      session = null;
    }
  }
  const credentials = zentroCredentials();
  if (!session && !credentials) throw new ZentroNotConfiguredError("import a CardHub session from /admin or set ZENTRO_USERNAME and ZENTRO_PASSWORD");
  return new ZentroClient({ session, credentials, onSession: persistSession });
}

export interface BrowserSessionInput {
  /** `connect.sid` cookie value as shown in DevTools (URL-encoded, starts with `s%3A`). */
  cookie: string;
  /** localStorage `cardhub_private_key` (X25519 JWK with `d`). */
  privateJwk: JWK;
  /** localStorage `cardhub_public_key`. */
  publicJwk: JWK;
  /** localStorage `cardhub_server_public_key`. */
  serverJwk: JWK;
}

function assertX25519(jwk: unknown, label: string, needPrivate: boolean): JWK {
  if (!jwk || typeof jwk !== "object") throw new Error(`${label}: expected a JSON object`);
  const j = jwk as JWK;
  if (j.kty !== "OKP" || j.crv !== "X25519" || typeof j.x !== "string") throw new Error(`${label}: expected an X25519 JWK (kty OKP, crv X25519, x)`);
  if (needPrivate && typeof j.d !== "string") throw new Error(`${label}: private JWK needs "d"`);
  return j;
}

/** Store a session copied out of a logged-in CardHub tab. Replaces whatever was stored. */
export async function importBrowserSession(input: BrowserSessionInput): Promise<void> {
  if (!configured.kms) throw new ZentroNotConfiguredError("FEE_ROUTER_KMS_KEY");
  let cookie = input.cookie.trim();
  if (cookie.startsWith("connect.sid=")) cookie = cookie.slice("connect.sid=".length);
  if (cookie.startsWith("s:")) cookie = encodeURIComponent(cookie);
  if (!cookie) throw new Error("cookie: connect.sid value is required");
  const session: ZentroSession = {
    cookie,
    privateJwk: assertX25519(input.privateJwk, "privateJwk", true),
    publicJwk: assertX25519(input.publicJwk, "publicJwk", false),
    serverJwk: assertX25519(input.serverJwk, "serverJwk", false),
  };
  // The imported session may be a different account: drop the old card binding and health so the
  // next probe re-derives them instead of querying a card id this account does not own.
  await upsert({ sessionEnc: encodeSession(session), cardId: null, last4: null, lastOkAt: null, lastError: null });
}

/** Card the rail operates: `ZENTRO_CARD_ID`, else the stored id, else the first card on the account. */
export async function zentroCardId(client: ZentroClient): Promise<string> {
  if (env.ZENTRO_CARD_ID) return env.ZENTRO_CARD_ID;
  const row = await loadRow();
  if (row?.cardId) return row.cardId;
  const cards = await client.cards();
  const first = cards[0];
  if (!first) throw new ZentroError("Zentro account has no cards");
  await upsert({ cardId: first.id, last4: first.last4 ?? null });
  return first.id;
}

/** What the store already knows about the card, without a network round-trip. */
export async function storedCard(): Promise<{ cardId: string | null; last4: string | null }> {
  const row = await loadRow();
  return { cardId: row?.cardId ?? null, last4: row?.last4 ?? null };
}

/**
 * Run `fn` against the stored client, recording lastOkAt on success and lastError on a Zentro
 * failure. Configuration errors propagate untouched so callers can report the exact missing piece.
 */
export async function withZentro<T>(fn: (client: ZentroClient) => Promise<T>): Promise<T> {
  const client = await getZentroClient();
  try {
    const out = await fn(client);
    await upsert({ lastOkAt: new Date(), lastError: null });
    return out;
  } catch (e) {
    if (e instanceof ZentroError) await upsert({ lastError: e.message });
    throw e;
  }
}

export interface ZentroStatus {
  connected: boolean;
  kmsConfigured: boolean;
  sessionStored: boolean;
  canRelogin: boolean;
  cardId: string | null;
  last4: string | null;
  balanceUsd: number | null;
  lastOkAt: Date | null;
  lastError: string | null;
}

/** Stored state; with `probe` also hits Zentro (state, card, balance) and persists what it learns. */
export async function zentroStatus(opts: { probe: boolean } = { probe: true }): Promise<ZentroStatus> {
  const row = await loadRow();
  const base: ZentroStatus = {
    connected: false,
    kmsConfigured: configured.kms,
    sessionStored: !!row,
    canRelogin: zentroCredentials() !== null,
    cardId: row?.cardId ?? null,
    last4: row?.last4 ?? null,
    balanceUsd: null,
    lastOkAt: row?.lastOkAt ?? null,
    lastError: row?.lastError ?? null,
  };
  let client: ZentroClient;
  try {
    client = await getZentroClient();
  } catch (e) {
    return { ...base, lastError: e instanceof Error ? e.message : String(e) };
  }
  if (!opts.probe) return { ...base, connected: !!row?.lastOkAt && !row.lastError };
  try {
    await client.state();
    const cardId = await zentroCardId(client);
    const card = await client.card(cardId);
    const balanceUsd = card.balance != null && Number.isFinite(Number(card.balance)) ? Number(card.balance) : null;
    const last4 = typeof card.last4 === "string" ? card.last4 : card.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : base.last4;
    const lastOkAt = new Date();
    await upsert({ cardId, last4, lastOkAt, lastError: null });
    return { ...base, connected: true, sessionStored: true, cardId, last4, balanceUsd, lastOkAt, lastError: null };
  } catch (e) {
    const lastError = e instanceof Error ? e.message : String(e);
    await upsert({ lastError });
    return { ...base, lastError };
  }
}
