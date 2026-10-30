import { configured, env } from "@/lib/env";

const API = "https://api.helius.xyz/v0";
const WEBHOOK_PATH = "/api/webhooks/helius";

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  accountAddresses: string[];
  transactionTypes: string[];
  webhookType: string;
  authHeader?: string;
}

function webhookUrl(): string {
  return `${env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "")}${WEBHOOK_PATH}`;
}

/** The Fee Router webhook as Helius currently has it, or null (not configured, or not registered yet). */
export async function findWebhook(): Promise<{ webhookId: string; webhookURL: string; accountAddresses: string[] } | null> {
  if (!configured.helius) return null;
  const res = await fetch(`${API}/webhooks?api-key=${env.HELIUS_API_KEY}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Helius list webhooks ${res.status}`);
  const url = webhookUrl();
  const hit = ((await res.json()) as HeliusWebhook[]).find((w) => w.webhookURL === url);
  if (!hit) return null;
  // The list omits accountAddresses; the single-webhook endpoint returns them.
  const one = await fetch(`${API}/webhooks/${hit.webhookID}?api-key=${env.HELIUS_API_KEY}`, { cache: "no-store" });
  if (!one.ok) throw new Error(`Helius get webhook ${one.status}`);
  const full = (await one.json()) as HeliusWebhook;
  return { webhookId: hit.webhookID, webhookURL: hit.webhookURL, accountAddresses: full.accountAddresses ?? [] };
}

/**
 * Register (or update) the single Fee Router webhook so Helius streams every enhanced transaction
 * touching a watched address (token routes + protocol treasury). Idempotent: keyed on our public
 * webhook URL. Returns the webhook id, or null with a log line when Helius is not configured.
 */
export async function ensureWebhook(addresses: string[]): Promise<string | null> {
  if (!configured.helius) {
    console.warn(`[helius] not configured (HELIUS_API_KEY + HELIUS_WEBHOOK_SECRET); ${addresses.length} address(es) not subscribed`);
    return null;
  }
  const webhookURL = webhookUrl();
  const key = env.HELIUS_API_KEY!;
  const existing = await findWebhook();
  const uniq = [...new Set(addresses)].sort();
  const body = { webhookURL, transactionTypes: ["ANY"], accountAddresses: uniq, webhookType: "enhanced", authHeader: env.HELIUS_WEBHOOK_SECRET };

  if (existing) {
    const same = existing.accountAddresses.length === uniq.length && [...existing.accountAddresses].sort().every((a, i) => a === uniq[i]);
    if (same) return existing.webhookId;
    const res = await fetch(`${API}/webhooks/${existing.webhookId}?api-key=${key}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Helius update webhook ${res.status}: ${await res.text()}`);
    return existing.webhookId;
  }
  const res = await fetch(`${API}/webhooks?api-key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Helius create webhook ${res.status}: ${await res.text()}`);
  return ((await res.json()) as HeliusWebhook).webhookID;
}

/* Enhanced-transaction payload shape (the subset we read). */
export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}
export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard?: string;
}
export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  timestamp: number;
  type?: string;
  source?: string;
  feePayer?: string;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: { account: string; nativeBalanceChange: number; tokenBalanceChanges?: { mint: string; rawTokenAmount: { tokenAmount: string; decimals: number }; userAccount: string }[] }[];
  instructions?: { programId: string; innerInstructions?: { programId: string }[] }[];
  transactionError?: unknown;
}
