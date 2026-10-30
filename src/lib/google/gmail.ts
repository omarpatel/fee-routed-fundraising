import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { CausePlatform } from "@/lib/db/schema";
import { refreshAccessToken } from "@/lib/auth/google-tokens";

/**
 * Gmail REST over fetch, authenticated with an operator's stored refresh token
 * (`google_tokens`, scopes gmail.readonly + gmail.send). Two jobs:
 *   - notify operators that a card is funded and a tap is due;
 *   - harvest the platform's donation confirmation as receipt evidence.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

/** Sender domains per platform; `other` searches all of them. */
const SENDER_DOMAINS: Partial<Record<CausePlatform, string[]>> = {
  gofundme: ["gofundme.com"],
  launchgood: ["launchgood.com"],
  justgiving: ["justgiving.com"],
  gogetfunding: ["gogetfunding.com"],
  everyorg: ["every.org"],
};
const ALL_DOMAINS = Object.values(SENDER_DOMAINS).flat();

async function gmail<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await refreshAccessToken(userId);
  const r = await fetch(`${API}/${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      /* not JSON */
    }
    throw new GmailError(`Gmail ${path.split("?")[0]} failed: ${r.status} ${detail}`, r.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Operator whose Gmail the system sends and reads as: the most recently connected operator/admin with gmail.send. */
export async function operatorMailer(): Promise<{ userId: string; email: string } | null> {
  const row = await db
    .select({ userId: schema.googleTokens.userId, email: schema.users.email })
    .from(schema.googleTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.googleTokens.userId))
    .where(and(inArray(schema.users.role, ["operator", "admin"]), like(schema.googleTokens.scopes, "%gmail.send%")))
    .orderBy(desc(schema.googleTokens.updatedAt))
    .get();
  return row ?? null;
}

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 encoded-word so non-ASCII subjects survive. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export async function sendOperatorEmail(userId: string, to: string | string[], subject: string, html: string): Promise<{ id: string }> {
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) throw new GmailError("No recipients");
  const message = [`To: ${recipients.join(", ")}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(html, "utf8").toString("base64")].join("\r\n");
  const r = await gmail<{ id: string }>(userId, "messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: b64url(Buffer.from(message, "utf8")) }) });
  return { id: r.id };
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessageFull {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function partsText(p: GmailPart | undefined, out: string[]): void {
  if (!p) return;
  if (p.body?.data && (!p.mimeType || p.mimeType.startsWith("text/"))) out.push(Buffer.from(p.body.data, "base64").toString("utf8"));
  for (const c of p.parts ?? []) partsText(c, out);
}

/** True when `text` states the amount (with or without `$`, thousands separators, NBSP). */
export function mentionsAmount(text: string, amountUsd: number): boolean {
  const fixed = amountUsd.toFixed(2);
  const flat = text.replace(/[,\u00a0\u202f]/g, "");
  return new RegExp(`(?<![\\d.])${fixed.replace(".", "\\.")}(?![\\d])`).test(flat);
}

export interface DonationEmail {
  id: string;
  subject: string;
  from: string;
  date: Date;
  /** RFC 822 bytes, exactly as Gmail stores them. */
  raw: Buffer;
}

/**
 * Newest message from the platform since `after` whose body states the donated amount.
 * Returns null when nothing matches (the confirmation may simply not have arrived yet).
 */
export async function findDonationEmail(userId: string, opts: { platform: CausePlatform; amountUsd: number; after: Date }): Promise<DonationEmail | null> {
  const domains = SENDER_DOMAINS[opts.platform] ?? ALL_DOMAINS;
  const q = `from:(${domains.join(" OR ")}) newer_than:2d`;
  const list = await gmail<{ messages?: { id: string }[] }>(userId, `messages?q=${encodeURIComponent(q)}&maxResults=25`);
  for (const m of list.messages ?? []) {
    const full = await gmail<GmailMessageFull>(userId, `messages/${m.id}?format=full`);
    const at = Number(full.internalDate ?? 0);
    if (!(at > opts.after.getTime())) continue;
    const texts: string[] = [];
    partsText(full.payload, texts);
    if (full.snippet) texts.push(full.snippet);
    if (!texts.some((t) => mentionsAmount(t, opts.amountUsd))) continue;
    const header = (name: string) => full.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const rawMsg = await gmail<{ raw: string }>(userId, `messages/${m.id}?format=raw`);
    return { id: full.id, subject: header("subject"), from: header("from"), date: new Date(at), raw: Buffer.from(rawMsg.raw, "base64url") };
  }
  return null;
}
