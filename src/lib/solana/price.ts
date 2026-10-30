import { env } from "@/lib/env";
import { SOL_MINT, USDC_MINT } from "./rpc";

const JUP_PRICE_URL = "https://api.jup.ag/price/v3";
const TTL_MS = 60_000;

interface CacheEntry {
  usd: number;
  at: number;
}
const cache = new Map<string, CacheEntry>();

interface JupPriceV3 {
  [mint: string]: { usdPrice: number; blockId?: number; decimals?: number; priceChange24h?: number } | undefined;
}

/**
 * USD price per whole unit of `mint`. USDC is pinned to 1. Memoised for 60s.
 * Throws when Jupiter is unreachable — callers must not persist a guessed price.
 */
export async function priceUsd(mint: string): Promise<number> {
  if (mint === USDC_MINT.toBase58()) return 1;
  const hit = cache.get(mint);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.usd;

  const headers: Record<string, string> = { accept: "application/json" };
  if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;
  const res = await fetch(`${JUP_PRICE_URL}?ids=${encodeURIComponent(mint)}`, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`Jupiter price ${res.status} for ${mint}`);
  const body = (await res.json()) as JupPriceV3;
  const usd = body[mint]?.usdPrice;
  if (typeof usd !== "number" || !Number.isFinite(usd)) throw new Error(`Jupiter returned no price for ${mint}`);
  cache.set(mint, { usd, at: now });
  return usd;
}

export function solPriceUsd(): Promise<number> {
  return priceUsd(SOL_MINT);
}

/** USD value of a raw integer amount, rounded to cents. */
export async function valueUsd(mint: string, amountRaw: bigint | string, decimals: number): Promise<number> {
  const p = await priceUsd(mint);
  const ui = Number(BigInt(amountRaw)) / 10 ** decimals;
  return Math.round(ui * p * 100) / 100;
}
