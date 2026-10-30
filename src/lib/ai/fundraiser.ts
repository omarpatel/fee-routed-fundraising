import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import type { Cause } from "@/lib/db/schema";
import { dataDir } from "@/lib/env";
import { claude, claudeModel, structured } from "./claude";

/**
 * Fact-check brief for a submitted fundraiser: fetch the campaign page server-side, reduce it to
 * text, and ask Claude to compare it with what the organizer typed into Fee Router. The brief is stored
 * as a file next to the ledger (`data/verification/<causeId>.json`) and shown to the operator, who
 * makes the verification decision. The brief never changes `causes.verificationStatus`.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_EMBEDDED_CHARS = 6_000;
const ROOT = path.join(dataDir, "verification");
const MAX_REDIRECTS = 5;

const Money = z.object({ amount: z.number(), currency: z.string().min(1).max(8) }).nullable();

export const FundraiserBriefSchema = z.object({
  platformMatches: z.boolean(),
  titleOnPage: z.string().nullable(),
  organizer: z.string().nullable(),
  beneficiary: z.string().nullable(),
  goal: Money,
  raised: Money,
  createdAt: z.string().nullable(),
  location: z.string().nullable(),
  consistencyIssues: z.array(z.string()),
  redFlags: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  questionsForOrganizer: z.array(z.string()).max(4),
});
export type FundraiserBrief = z.infer<typeof FundraiserBriefSchema>;

export interface StoredBrief {
  causeId: string;
  url: string;
  /** Model and time of the run; the operator sees both. */
  model: string;
  checkedAt: string;
  fetch: { status: number | null; bytes: number; textChars: number; embeddedJson: boolean; error: string | null };
  brief: FundraiserBrief;
}

/* ---------------- page extraction ---------------- */

export interface ExtractedPage {
  status: number | null;
  bytes: number;
  /** Title + meta/og tags + visible text, ≤ MAX_TEXT_CHARS. */
  text: string;
  /** Trimmed JSON found in __NEXT_DATA__ / window.__* blobs, or null. */
  embedded: string | null;
  error: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/** Pull the campaign-shaped part out of embedded JSON: keys that look like fundraiser data, capped. */
function pickEmbedded(html: string): string | null {
  const blobs: string[] = [];
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (next) blobs.push(next[1]);
  for (const m of html.matchAll(/window\.__[A-Za-z0-9_]+__?\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) blobs.push(m[1]);
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) blobs.push(m[1]);
  if (!blobs.length) return null;
  const wanted = /"(title|name|description|story|organizer|beneficiary|goal|goal_amount|goalAmount|current_amount|currentAmount|raised|amount_raised|balance|currency|created_at|createdAt|launch_date|launchDate|location|city|state|country|status|is_active|deactivated|closed|category|charity)"\s*:\s*("(?:[^"\\]|\\.){0,400}"|-?\d+(?:\.\d+)?|true|false|null|\{"(?:amount|value|currency)[^}]{0,200}\})/g;
  const out: string[] = [];
  const seen: Record<string, true> = {};
  for (const b of blobs) {
    for (const m of b.matchAll(wanted)) {
      const line = `${m[1]}: ${m[2]}`;
      if (seen[line]) continue;
      seen[line] = true;
      out.push(line);
      if (out.join("\n").length > MAX_EMBEDDED_CHARS) return out.join("\n").slice(0, MAX_EMBEDDED_CHARS);
    }
  }
  return out.length ? out.join("\n") : null;
}

export function extractText(html: string): { text: string; embedded: string | null } {
  const embedded = pickEmbedded(html);
  const head: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) head.push(`title: ${decodeEntities(title[1]).replace(/\s+/g, " ").trim()}`);
  for (const m of html.matchAll(/<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi)) {
    const k = m[1].toLowerCase();
    if (/^(description|og:|twitter:|article:|fundraiser|campaign)/.test(k)) head.push(`${k}: ${decodeEntities(m[2]).replace(/\s+/g, " ").trim()}`);
  }
  for (const m of html.matchAll(/<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["']([^"']+)["'][^>]*>/gi)) {
    const k = m[2].toLowerCase();
    if (/^(description|og:|twitter:|article:|fundraiser|campaign)/.test(k)) head.push(`${k}: ${decodeEntities(m[1]).replace(/\s+/g, " ").trim()}`);
  }
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const visible = decodeEntities(body)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const text = `${head.join("\n")}\n\n${visible}`.slice(0, MAX_TEXT_CHARS);
  return { text, embedded };
}

/**
 * The cause URL is typed by any signed-in user; the fetch runs on our server. Loopback, private,
 * link-local (cloud metadata), CGNAT, multicast and reserved ranges are never fetched.
 */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

/** Throws unless `url` is http(s) and every address its host resolves to is public. */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Refused to fetch ${url.protocol} URL`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`${host} did not resolve`);
  for (const a of addrs) if (NON_PUBLIC.check(a.address, a.family === 6 ? "ipv6" : "ipv4")) throw new Error(`Refused to fetch ${host}: resolves to non-public address ${a.address}`);
}

export async function fetchFundraiserPage(url: string): Promise<ExtractedPage> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Redirects are followed by hand so every hop is re-checked.
    let target = new URL(url);
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(target);
      res = await fetch(target, {
        signal: ctl.signal,
        redirect: "manual",
        cache: "no-store",
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 FeeRouterVerifier/1.0",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.8",
        },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects`);
      target = new URL(location, target);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        bytes += value.length;
        if (bytes >= MAX_HTML_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const html = Buffer.concat(chunks).subarray(0, MAX_HTML_BYTES).toString("utf8");
    const { text, embedded } = extractText(html);
    return { status: res.status, bytes, text, embedded, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s` : e.message) : String(e);
    return { status: null, bytes: 0, text: "", embedded: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- the brief ---------------- */

const SYSTEM = `You are a fact-checking assistant for Fee Router, a service that delivers money to online fundraisers. An organizer submitted a fundraiser to Fee Router; you are given (a) what they typed into the Fee Router form and (b) the text and embedded data of the fundraiser page as fetched by a server just now. Compare them.

Rules:
- Only state facts that are literally on the page or in its embedded data. If a field is not present, return null. Never guess amounts or dates.
- "platformMatches" is whether the page is actually hosted on the platform the organizer selected (e.g. gofundme.com for GoFundMe).
- "consistencyIssues" are differences between the submission and the page (title, beneficiary, goal, location, story details).
- "redFlags" are things an operator must look at before money moves: page not found, fetch blocked, campaign closed or deactivated, beneficiary mismatch, story that reads like a copy of another campaign, generic or templated language, goal far above what is described, no organizer identity, brand-new campaign with no updates.
- "confidence" reflects how much of the page you could actually read. If the fetch failed or the text is mostly navigation chrome, say "low".
- "summary" is at most 60 words, plain English, for a human operator. "questionsForOrganizer" are at most 4 concrete questions whose answers would resolve the issues.
- You do not decide whether the fundraiser is verified. A human does. Do not use the words "approve" or "reject".`;

const TOOL_SCHEMA = {
  properties: {
    platformMatches: { type: "boolean" },
    titleOnPage: { type: ["string", "null"] },
    organizer: { type: ["string", "null"] },
    beneficiary: { type: ["string", "null"] },
    goal: { type: ["object", "null"], properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount", "currency"] },
    raised: { type: ["object", "null"], properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount", "currency"] },
    createdAt: { type: ["string", "null"], description: "ISO date or the page's own wording" },
    location: { type: ["string", "null"] },
    consistencyIssues: { type: "array", items: { type: "string" } },
    redFlags: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string", description: "≤ 60 words" },
    questionsForOrganizer: { type: "array", items: { type: "string" }, maxItems: 4 },
  },
  required: ["platformMatches", "titleOnPage", "organizer", "beneficiary", "goal", "raised", "createdAt", "location", "consistencyIssues", "redFlags", "confidence", "summary", "questionsForOrganizer"],
};

type CauseInput = Pick<Cause, "id" | "title" | "summary" | "story" | "beneficiary" | "platform" | "url" | "goalUsd" | "location" | "category">;

/** Fetch + compare. Throws `AiNotConfiguredError` before touching the network when Claude is off. */
export async function checkFundraiser(cause: CauseInput): Promise<StoredBrief> {
  // Fail on configuration first: no point fetching a page nobody will read.
  claude();
  const page = await fetchFundraiserPage(cause.url);
  const submitted = {
    platform: cause.platform,
    url: cause.url,
    title: cause.title,
    summary: cause.summary,
    beneficiary: cause.beneficiary,
    goalUsd: cause.goalUsd,
    location: cause.location,
    category: cause.category,
    story: cause.story.slice(0, 6000),
  };
  const user = [
    "## Submitted to Fee Router",
    JSON.stringify(submitted, null, 2),
    "",
    `## Fetch result`,
    `status: ${page.status ?? "none"} · bytes: ${page.bytes} · error: ${page.error ?? "none"}`,
    "",
    "## Page text",
    page.text || "(empty)",
    "",
    "## Embedded data",
    page.embedded ?? "(none)",
  ].join("\n");
  const brief = await structured<FundraiserBrief>({
    system: SYSTEM,
    user,
    tool: { name: "record_fundraiser_brief", description: "Record the fact-check brief for the operator.", inputSchema: TOOL_SCHEMA },
    parse: FundraiserBriefSchema,
    maxTokens: 1500,
  });
  const stored: StoredBrief = {
    causeId: cause.id,
    url: cause.url,
    model: claudeModel(),
    checkedAt: new Date().toISOString(),
    fetch: { status: page.status, bytes: page.bytes, textChars: page.text.length, embeddedJson: page.embedded !== null, error: page.error },
    brief,
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(briefPath(cause.id), JSON.stringify(stored, null, 2));
  return stored;
}

function briefPath(causeId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(causeId)) throw new Error("Bad cause id");
  return path.join(ROOT, `${causeId}.json`);
}

export async function readFundraiserBrief(causeId: string): Promise<StoredBrief | null> {
  try {
    return JSON.parse(await readFile(briefPath(causeId), "utf8")) as StoredBrief;
  } catch {
    return null;
  }
}
