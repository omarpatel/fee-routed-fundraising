import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { googleTokens } from "@/lib/db/schema";
import { configured, env } from "@/lib/env";
import { findWebhook } from "@/lib/solana/helius";
import { ANCHOR_SIGNER_MIN_SOL, anchorSignerStatus } from "@/lib/solana/memo";

export interface IntegrationStatus {
  key: "kms" | "rpc" | "helius" | "jupiter" | "bags" | "google" | "gmail" | "zentro" | "anchor" | "claude";
  label: string;
  /** true = ready, false = missing config, null = configured but the live check failed. */
  ok: boolean | null;
  detail: string;
}

/** One row per external dependency, with a specific reason when it is not ready. */
export async function integrationStatuses(): Promise<IntegrationStatus[]> {
  const rpcHost = env.SOLANA_RPC_URL ? new URL(env.SOLANA_RPC_URL).host : null;
  const zentroCard = env.ZENTRO_CARD_ID;

  const [helius, gmail, anchor] = await Promise.all([
    (async (): Promise<IntegrationStatus> => {
      if (!configured.helius) return { key: "helius", label: "Helius webhook", ok: false, detail: "HELIUS_API_KEY + HELIUS_WEBHOOK_SECRET missing" };
      try {
        const hook = await findWebhook();
        return hook ? { key: "helius", label: "Helius webhook", ok: true, detail: `Registered · ${hook.accountAddresses.length} address(es) · ${hook.webhookId}` } : { key: "helius", label: "Helius webhook", ok: null, detail: "Configured, not registered yet" };
      } catch (e) {
        return { key: "helius", label: "Helius webhook", ok: null, detail: `List failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    })(),
    db.select({ n: sql<number>`count(*)` }).from(googleTokens).get(),
    (async (): Promise<IntegrationStatus> => {
      if (!configured.anchor) return { key: "anchor", label: "Anchor signer", ok: false, detail: "Receipts are not anchored: needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL" };
      const s = await anchorSignerStatus();
      if (s.solBalance === null) return { key: "anchor", label: "Anchor signer", ok: null, detail: `${s.address} · balance unavailable` };
      return {
        key: "anchor",
        label: "Anchor signer",
        ok: s.low ? null : true,
        detail: `${s.address} · ${s.solBalance.toFixed(4)} SOL${s.low ? ` · low: fund with ≥ ${ANCHOR_SIGNER_MIN_SOL} SOL or receipts stay unanchored` : ""}`,
      };
    })(),
  ]);
  const gmailCount = gmail?.n ?? 0;

  return [
    { key: "kms", label: "KMS", ok: configured.kms, detail: configured.kms ? "AES-256-GCM key loaded" : "FEE_ROUTER_KMS_KEY missing (64 hex chars)" },
    { key: "rpc", label: "Solana RPC", ok: configured.rpc, detail: rpcHost ? rpcHost : "SOLANA_RPC_URL missing; public mainnet read-only fallback" },
    helius,
    anchor,
    { key: "jupiter", label: "Jupiter", ok: configured.jupiter, detail: configured.jupiter ? "Price + swap API key set" : "JUPITER_API_KEY missing; price lookups run unauthenticated" },
    { key: "bags", label: "Bags", ok: configured.bags, detail: configured.bags ? "Fee-share read key set (connecting existing Bags tokens)" : "BAGS_API_KEY missing; Bags routes verify by inflow only" },
    { key: "google", label: "Google auth", ok: configured.google, detail: configured.google ? "OAuth client + session secret set" : "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or SESSION_SECRET missing" },
    { key: "gmail", label: "Gmail", ok: gmailCount > 0, detail: gmailCount > 0 ? `${gmailCount} operator token(s) on file` : "No operator has granted gmail scopes yet" },
    { key: "zentro", label: "Zentro", ok: configured.zentroLogin, detail: configured.zentroLogin ? (zentroCard ? `Credentials set · card ${zentroCard.slice(0, 8)}…` : "Credentials set; ZENTRO_CARD_ID missing (first card is used)") : "ZENTRO_USERNAME / ZENTRO_PASSWORD missing; runs on an imported session only" },
    { key: "claude", label: "Claude", ok: configured.claude, detail: configured.claude ? `${env.ANTHROPIC_MODEL} · fact-check briefs, story suggestions, reconciliation notes (assistive only)` : "ANTHROPIC_API_KEY missing; verification briefs and story suggestions are off" },
  ];
}
