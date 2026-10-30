import { BAGS_FEE_SHARE_V2_PROGRAM_ID } from "@bagsfm/bags-sdk";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { feeEvents, protocolFeeEvents, tokens, webhookEvents } from "@/lib/db/schema";
import { getProtocolConfig } from "@/lib/protocol/config";
import type { HeliusEnhancedTx } from "@/lib/solana/helius";
import { mintDecimals } from "@/lib/solana/jupiter";
import { valueUsd } from "@/lib/solana/price";
import { FEE_SOURCE_PROGRAMS, JUPITER_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMPFUN_PROGRAM_ID, SOL_MINT, USDC_MINT } from "@/lib/solana/rpc";

/** The only assets the sweep turns into treasury USDC, hence the only ones worth a USD value. */
const VALUED_MINTS: Record<string, true> = { [SOL_MINT]: true, [USDC_MINT.toBase58()]: true };

export interface IngestResult {
  signature: string;
  /** Already in the inbox; nothing done. */
  duplicate: boolean;
  inserted: number;
  error: string | null;
}

interface Inflow {
  address: string;
  mint: string;
  raw: bigint;
  decimals: number | null;
}

/**
 * Positive balance changes on watched addresses, keyed `address:mint`. Exact raw amounts from
 * `accountData` win; `tokenTransfers` (a UI float) only fills gaps; native SOL is exact in lamports.
 */
async function collectInflows(tx: HeliusEnhancedTx, watched: (address: string) => boolean): Promise<Inflow[]> {
  const inflows: Record<string, Inflow> = {};
  const add = (address: string, mint: string, raw: bigint, decimals: number | null) => {
    if (!watched(address) || raw <= BigInt(0)) return;
    const key = `${address}:${mint}`;
    const cur = inflows[key];
    if (cur) cur.raw += raw;
    else inflows[key] = { address, mint, raw, decimals };
  };

  for (const n of tx.nativeTransfers ?? []) add(n.toUserAccount, SOL_MINT, BigInt(Math.round(n.amount)), 9);
  const seenRaw: Record<string, true> = {};
  for (const a of tx.accountData ?? []) {
    for (const c of a.tokenBalanceChanges ?? []) {
      if (!watched(c.userAccount)) continue;
      const raw = BigInt(c.rawTokenAmount.tokenAmount);
      if (raw <= BigInt(0)) continue;
      seenRaw[`${c.userAccount}:${c.mint}`] = true;
      add(c.userAccount, c.mint, raw, c.rawTokenAmount.decimals);
    }
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (!watched(t.toUserAccount) || seenRaw[`${t.toUserAccount}:${t.mint}`]) continue;
    const decimals = await mintDecimals(t.mint);
    add(t.toUserAccount, t.mint, BigInt(Math.round(t.tokenAmount * 10 ** decimals)), decimals);
  }
  return Object.values(inflows);
}

/** Every program id touched by the transaction, outer and inner. */
function txPrograms(tx: HeliusEnhancedTx): Set<string> {
  const programs = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    programs.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) programs.add(inner.programId);
  }
  return programs;
}

/**
 * One Helius enhanced transaction → zero or more `fee_events`.
 * Idempotent twice over: the inbox is keyed on signature, and fee_events is unique on (txSig, assetMint).
 * USD is snapshotted from Jupiter at ingest time; webhooks arrive within seconds of the block, which is
 * the closest thing to a block-time price the v3 price API offers. Only SOL and USDC are valued:
 * any other mint is recorded as a $0 `transfer`, so dusting a route with a token whose Jupiter
 * price can be pushed around cannot inflate the deliverable balance.
 */
export async function ingestHeliusTx(tx: HeliusEnhancedTx, routes: Record<string, { tokenId: string; vaultId: string }>): Promise<IngestResult> {
  const inbox = await db
    .insert(webhookEvents)
    .values({ id: `whk_${nanoid(12)}`, provider: "helius", dedupeKey: tx.signature, payload: tx, createdAt: new Date() })
    .onConflictDoNothing({ target: webhookEvents.dedupeKey })
    .returning({ id: webhookEvents.id });
  if (inbox.length === 0) return { signature: tx.signature, duplicate: true, inserted: 0, error: null };
  return processInbox(inbox[0].id, tx, routes);
}

/** Final, not retried: nothing moved. */
const FAILED_ON_CHAIN = "transaction failed on-chain; ignored";

async function processInbox(inboxId: string, tx: HeliusEnhancedTx, routes: Record<string, { tokenId: string; vaultId: string }>): Promise<IngestResult> {
  try {
    if (tx.transactionError) throw new Error(FAILED_ON_CHAIN);
    const inflows = await collectInflows(tx, (a) => !!routes[a]);
    const programs = txPrograms(tx);
    const fromFeeProgram = [...programs].some((p) => FEE_SOURCE_PROGRAMS[p]) || tx.source === "PUMP_FUN" || tx.source === "PUMP_AMM";
    const kind = fromFeeProgram ? "creator_fee" : "transfer";
    const blockTime = new Date(tx.timestamp * 1000);
    // The sweep is the only Jupiter swap a route pays for; its USDC lands on the route before moving on to
    // the treasury, and booking it would count the same fees twice. Anything else the route signs (a creator
    // fee claim through pump.fun or PumpSwap) brings value in and is booked.
    const ownSwap = programs.has(JUPITER_PROGRAM_ID) || tx.source === "JUPITER";

    let inserted = 0;
    for (const f of inflows) {
      if (ownSwap && tx.feePayer === f.address) continue;
      const { tokenId, vaultId } = routes[f.address];
      const valued = VALUED_MINTS[f.mint] === true;
      const decimals = f.decimals ?? (await mintDecimals(f.mint));
      const amountUsd = valued ? await valueUsd(f.mint, f.raw, decimals) : 0;
      const eventKind = valued ? kind : "transfer";
      const r = await db
        .insert(feeEvents)
        .values({ id: `fee_${nanoid(12)}`, vaultId, tokenId, txSig: tx.signature, slot: tx.slot, blockTime, assetMint: f.mint, amountRaw: f.raw.toString(), decimals, amountUsd, kind: eventKind, sweepId: null, createdAt: new Date() })
        .onConflictDoNothing({ target: [feeEvents.txSig, feeEvents.assetMint] })
        .returning({ id: feeEvents.id });
      inserted += r.length;
    }
    await db.update(webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(webhookEvents.id, inboxId));
    return { signature: tx.signature, duplicate: false, inserted, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(webhookEvents).set({ processedAt: new Date(), error }).where(eq(webhookEvents.id, inboxId));
    return { signature: tx.signature, duplicate: false, inserted: 0, error };
  }
}

/**
 * Re-run inbox rows whose ingest threw (price feed or RPC down). The webhook answered 200, so Helius
 * never redelivers them and their fees would otherwise never be booked. Safe to repeat: fee_events
 * are unique on (txSig, assetMint). Least recently tried first, at most `limit` per call, so rows that
 * keep failing cannot starve the rest.
 */
export async function retryFailedIngests(limit = 50): Promise<IngestResult[]> {
  const rows = await db
    .select({ id: webhookEvents.id, payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(and(isNotNull(webhookEvents.error), ne(webhookEvents.error, FAILED_ON_CHAIN)))
    .orderBy(webhookEvents.processedAt)
    .limit(limit);
  if (rows.length === 0) return [];
  const routes = await routeIndex();
  const out: IngestResult[] = [];
  for (const r of rows) out.push(await processInbox(r.id, r.payload as HeliusEnhancedTx, routes));
  return out;
}

export interface ProtocolIngestResult {
  signature: string;
  inserted: number;
  error: string | null;
}

/** Fee programs whose payout to the protocol treasury is labelled by name; anything else is a plain transfer. */
const PROTOCOL_SOURCE_PROGRAMS: Record<string, string> = { [PUMPFUN_PROGRAM_ID]: "pumpfun", [PUMP_FEE_PROGRAM_ID]: "pump_fee", [String(BAGS_FEE_SHARE_V2_PROGRAM_ID)]: "bags_fee_share" };

/**
 * One Helius enhanced transaction → zero or more `protocol_fee_events` for inflows to the protocol
 * treasury. Runs beside `ingestHeliusTx` (which owns the inbox row); idempotent on (txSig, assetMint).
 * `treasuryAddress` null (treasury not created yet) is a no-op.
 */
export async function ingestProtocolTx(tx: HeliusEnhancedTx, treasuryAddress: string | null): Promise<ProtocolIngestResult> {
  if (!treasuryAddress || tx.transactionError) return { signature: tx.signature, inserted: 0, error: null };
  try {
    const inflows = await collectInflows(tx, (a) => a === treasuryAddress);
    if (inflows.length === 0) return { signature: tx.signature, inserted: 0, error: null };
    const programs = txPrograms(tx);
    const source = [...programs].map((p) => PROTOCOL_SOURCE_PROGRAMS[p]).find(Boolean) ?? (tx.source === "PUMP_FUN" || tx.source === "PUMP_AMM" ? "pumpfun" : "transfer");
    const blockTime = new Date(tx.timestamp * 1000);
    let inserted = 0;
    for (const f of inflows) {
      const decimals = f.decimals ?? (await mintDecimals(f.mint));
      const amountUsd = await valueUsd(f.mint, f.raw, decimals);
      const r = await db
        .insert(protocolFeeEvents)
        .values({ id: `pfe_${nanoid(12)}`, txSig: tx.signature, slot: tx.slot, blockTime, assetMint: f.mint, amountRaw: f.raw.toString(), decimals, amountUsd, source, createdAt: new Date() })
        .onConflictDoNothing({ target: [protocolFeeEvents.txSig, protocolFeeEvents.assetMint] })
        .returning({ id: protocolFeeEvents.id });
      inserted += r.length;
    }
    return { signature: tx.signature, inserted, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[ingest] protocol treasury ${tx.signature}: ${error}`);
    return { signature: tx.signature, inserted: 0, error };
  }
}

export async function routeIndex(): Promise<Record<string, { tokenId: string; vaultId: string }>> {
  const rows = await db.select({ id: tokens.id, vaultId: tokens.vaultId, routeAddress: tokens.routeAddress }).from(tokens);
  const out: Record<string, { tokenId: string; vaultId: string }> = {};
  for (const r of rows) out[r.routeAddress] = { tokenId: r.id, vaultId: r.vaultId };
  return out;
}

/** Every address the Helius webhook must watch: token route addresses plus the protocol treasury. */
export async function watchedAddresses(): Promise<string[]> {
  const [routes, treasury] = await Promise.all([db.select({ routeAddress: tokens.routeAddress }).from(tokens), getProtocolConfig("protocol_treasury_address")]);
  const out = routes.map((r) => r.routeAddress);
  if (treasury) out.push(treasury);
  return out;
}
