import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { protocolConfig } from "@/lib/db/schema";

/**
 * Singleton protocol settings. Kept apart from `./index` so the ledger ingest path can read the
 * treasury address without pulling in vault/launch code (which imports the ledger back).
 */
export const PROTOCOL_CONFIG_KEYS = ["protocol_treasury_address", "protocol_mint", "protocol_launch_id"] as const;
export type ProtocolConfigKey = (typeof PROTOCOL_CONFIG_KEYS)[number];

export async function getProtocolConfig(key: ProtocolConfigKey): Promise<string | null> {
  const row = await db.select({ value: protocolConfig.value }).from(protocolConfig).where(eq(protocolConfig.key, key)).get();
  return row?.value ?? null;
}

export async function setProtocolConfig(key: ProtocolConfigKey, value: string): Promise<void> {
  const now = new Date();
  await db
    .insert(protocolConfig)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: protocolConfig.key, set: { value, updatedAt: now } });
}

/**
 * Insert-if-absent. Returns the value that is now stored, which is `value` only when this call won.
 * Two concurrent `ensure*` calls must agree on one address; the loser discards what it minted.
 */
export async function setProtocolConfigIfAbsent(key: ProtocolConfigKey, value: string): Promise<string> {
  const r = await db
    .insert(protocolConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoNothing({ target: protocolConfig.key })
    .returning({ value: protocolConfig.value });
  if (r.length > 0) return r[0].value;
  return (await getProtocolConfig(key))!;
}
