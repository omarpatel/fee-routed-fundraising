import { z } from "zod";
import { fail, ok, route } from "@/app/api/_lib";
import { configured, env } from "@/lib/env";
import { ingestHeliusTx, ingestProtocolTx, routeIndex } from "@/lib/ledger/ingest";
import { getProtocolConfig } from "@/lib/protocol/config";
import type { HeliusEnhancedTx } from "@/lib/solana/helius";

const Tx = z
  .object({
    signature: z.string().min(32),
    slot: z.number().int(),
    timestamp: z.number(),
    type: z.string().optional(),
    source: z.string().optional(),
    feePayer: z.string().optional(),
    nativeTransfers: z.array(z.object({ fromUserAccount: z.string(), toUserAccount: z.string(), amount: z.number() })).optional(),
    tokenTransfers: z.array(z.object({ fromUserAccount: z.string(), toUserAccount: z.string(), fromTokenAccount: z.string(), toTokenAccount: z.string(), tokenAmount: z.number(), mint: z.string(), tokenStandard: z.string().optional() })).optional(),
    accountData: z
      .array(
        z.object({
          account: z.string(),
          nativeBalanceChange: z.number(),
          tokenBalanceChanges: z.array(z.object({ mint: z.string(), rawTokenAmount: z.object({ tokenAmount: z.string(), decimals: z.number() }), userAccount: z.string() })).optional(),
        }),
      )
      .optional(),
    instructions: z.array(z.object({ programId: z.string(), innerInstructions: z.array(z.object({ programId: z.string() })).optional() })).optional(),
    transactionError: z.unknown().optional(),
  })
  .passthrough();

const Payload = z.array(Tx);

/** Helius enhanced-transaction webhook. Auth: `Authorization` header must equal HELIUS_WEBHOOK_SECRET. */
export const POST = route(async (req) => {
  if (!configured.helius) return fail("Helius not configured", 503);
  if (req.headers.get("authorization") !== env.HELIUS_WEBHOOK_SECRET) return fail("Unauthorized", 401);
  const parsed = Payload.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Malformed payload", 400);
  const [routes, treasury] = await Promise.all([routeIndex(), getProtocolConfig("protocol_treasury_address")]);
  const results = [];
  const protocol = [];
  for (const tx of parsed.data) {
    results.push(await ingestHeliusTx(tx satisfies HeliusEnhancedTx, routes));
    protocol.push(await ingestProtocolTx(tx, treasury));
  }
  return ok({
    received: results.length,
    inserted: results.reduce((a, r) => a + r.inserted, 0),
    duplicates: results.filter((r) => r.duplicate).length,
    protocolInserted: protocol.reduce((a, r) => a + r.inserted, 0),
    errors: [...results, ...protocol].filter((r) => r.error).map((r) => ({ signature: r.signature, error: r.error })),
  });
});
