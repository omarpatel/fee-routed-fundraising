import { PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type FeeRouterDb } from "@/lib/db";
import { getReceipt } from "@/lib/db/queries";
import {
  causes,
  deliveries,
  deliveryAllocations,
  feeEvents,
  launches,
  periods,
  receiptArtifacts,
  sweeps,
  tokens,
  vaults,
  type Cause,
  type CausePlatform,
  type Delivery,
  type DeliveryStatus,
  type Period,
  type ReceiptArtifact,
  type Token,
  type TokenSource,
  type Vault,
} from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { generateKey, hasKey } from "@/lib/keys";
import { canonicalJson, storeBuffer } from "@/lib/ledger/artifacts";
import { withLock } from "@/lib/ledger/locks";
import { canonicalReceipt, memoFor, receiptHash } from "@/lib/proof";
import { railForCause } from "@/lib/rails";
import { watchedAddresses } from "@/lib/ledger/ingest";
import { ensureWebhook } from "@/lib/solana/helius";
import { anchorMemo } from "@/lib/solana/memo";
import { FEE_SOURCE_PROGRAMS, SOL_MINT, USDC_MINT, fromUsdcRaw, isValidAddress, rpc, toUsdcRaw } from "@/lib/solana/rpc";
import { usdcBalance } from "@/lib/solana/transfer";
import { getBagsFeeShareClaimers } from "@/lib/launchpads/bags";

const WEEK_MS = 7 * 86_400_000;
/** A finalize that set `deliveredAt` but never sealed (crash mid-way) may be retried after this. */
const SEAL_LEASE_MS = 5 * 60_000;
const IN_FLIGHT: Delivery["status"][] = ["queued", "funding", "funded", "executing"];
const COUNTED: Delivery["status"][] = ["queued", "funding", "funded", "executing", "delivered"];
/**
 * A failed/reversed delivery whose funding transfer left the treasury (fundingTxSig set) is stranded:
 * its USDC is gone even though the cause never got it, so it keeps counting against the balance
 * until it is recovered (`recoverStrandedFunding`). Releasing it earlier would let the next
 * delivery be paid out of the ops reserve (donateBps < 10000).
 */
const counted = or(inArray(deliveries.status, COUNTED), and(inArray(deliveries.status, ["failed", "reversed"]), isNotNull(deliveries.fundingTxSig), isNull(deliveries.fundingRecoveredAt)));
/** Only assets the sweep actually turns into treasury USDC count towards the deliverable balance. */
const VALUED_MINTS = [SOL_MINT, USDC_MINT.toBase58()];

/** `db` or the executor inside a `db.transaction` callback. */
type Dbx = FeeRouterDb | Parameters<Parameters<FeeRouterDb["transaction"]>[0]>[0];

const newId = (prefix: string) => `${prefix}_${nanoid(12)}`;
const cents = (n: number) => Math.round(n * 100);
const sum = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)`;

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/* ------------------------------------------------------------------ */
/* Causes / vaults / tokens                                             */
/* ------------------------------------------------------------------ */

export interface CreateCauseInput {
  slug: string;
  title: string;
  summary: string;
  story: string;
  beneficiary: string;
  platform: CausePlatform;
  url: string;
  onchainAddress?: string | null;
  goalUsd?: number | null;
  raisedExternalUsd?: number | null;
  currency?: string;
  imageUrl?: string | null;
  location?: string | null;
  category?: string;
  createdBy?: string | null;
}

export async function createCause(input: CreateCauseInput): Promise<Cause> {
  if (input.platform === "onchain") {
    if (!input.onchainAddress || !isValidAddress(input.onchainAddress)) throw new LedgerError("On-chain causes need a valid Solana recipient address");
  }
  const existing = await db.select({ id: causes.id }).from(causes).where(eq(causes.slug, input.slug)).get();
  if (existing) throw new LedgerError(`Cause slug "${input.slug}" is taken`, 409);
  const row: typeof causes.$inferInsert = {
    id: newId("cau"),
    slug: input.slug,
    title: input.title,
    summary: input.summary,
    story: input.story,
    beneficiary: input.beneficiary,
    platform: input.platform,
    url: input.url,
    onchainAddress: input.platform === "onchain" ? input.onchainAddress! : null,
    goalUsd: input.goalUsd ?? null,
    raisedExternalUsd: input.raisedExternalUsd ?? null,
    currency: input.currency ?? "USD",
    imageUrl: input.imageUrl ?? null,
    location: input.location ?? null,
    category: input.category ?? "medical",
    verificationStatus: "pending",
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
  };
  await db.insert(causes).values(row);
  return (await db.select().from(causes).where(eq(causes.id, row.id)).get())!;
}

export interface CreateVaultInput {
  slug: string;
  name: string;
  tagline?: string | null;
  causeId: string;
  ownerUserId: string;
  donateBps?: number;
  deliveryThresholdUsd?: number;
}

/** Creates the vault and its custodial USDC treasury. Requires FEE_ROUTER_KMS_KEY. */
export async function createVault(input: CreateVaultInput): Promise<Vault> {
  if (!configured.kms) throw new LedgerError("KMS not configured", 503);
  const cause = await db.select({ id: causes.id }).from(causes).where(eq(causes.id, input.causeId)).get();
  if (!cause) throw new LedgerError("Cause not found", 404);
  const existing = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.slug, input.slug)).get();
  if (existing) throw new LedgerError(`Vault slug "${input.slug}" is taken`, 409);
  const id = newId("vlt");
  const { address } = await generateKey("vault_treasury", id);
  const row: typeof vaults.$inferInsert = {
    id,
    slug: input.slug,
    name: input.name,
    tagline: input.tagline ?? null,
    causeId: input.causeId,
    ownerUserId: input.ownerUserId,
    treasuryAddress: address,
    status: "active",
    donateBps: input.donateBps ?? 10000,
    deliveryThresholdUsd: input.deliveryThresholdUsd ?? 250,
    createdAt: new Date(),
  };
  await db.insert(vaults).values(row);
  await ensureOpenPeriod(id);
  return (await db.select().from(vaults).where(eq(vaults.id, id)).get())!;
}

export interface ConnectTokenInput {
  vaultId: string;
  mint: string;
  symbol: string;
  name: string;
  imageUrl?: string | null;
  source: TokenSource;
  launchpadUrl?: string | null;
  creatorWallet?: string | null;
  routeBps?: number;
  launchedViaFeeRouter?: boolean;
  /** Route key minted ahead of time (Bags launch: the fee-share config must exist before the mint). */
  routeAddress?: string;
  routeLocked?: boolean;
  routeProofTx?: string | null;
}

/** Registers a token and mints its dedicated fee route address. Requires FEE_ROUTER_KMS_KEY. */
export async function connectToken(input: ConnectTokenInput): Promise<Token> {
  if (!configured.kms) throw new LedgerError("KMS not configured", 503);
  if (!isValidAddress(input.mint)) throw new LedgerError("Invalid mint address");
  const vault = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, input.vaultId)).get();
  if (!vault) throw new LedgerError("Vault not found", 404);
  // Only a locked route owns a mint: unverified connections from different vaults coexist until one proves the creator redirected fees to it (see verifyRoute).
  const taken = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.mint, input.mint), isNull(tokens.supersededAt), or(eq(tokens.routeLocked, true), eq(tokens.vaultId, input.vaultId))))
    .get();
  if (taken) throw new LedgerError("Token already connected", 409);
  const id = newId("tok");
  let address = input.routeAddress;
  if (address) {
    if (!(await hasKey(address))) throw new LedgerError("routeAddress is not a Fee Router custodial key");
  } else address = (await generateKey("token_route", id)).address;
  const row: typeof tokens.$inferInsert = {
    id,
    vaultId: input.vaultId,
    mint: input.mint,
    symbol: input.symbol,
    name: input.name,
    imageUrl: input.imageUrl ?? null,
    source: input.source,
    launchpadUrl: input.launchpadUrl ?? null,
    creatorWallet: input.creatorWallet ?? null,
    routeAddress: address,
    routeBps: input.routeBps ?? 10000,
    routeLocked: input.routeLocked ?? false,
    routeProofTx: input.routeProofTx ?? null,
    launchedViaFeeRouter: input.launchedViaFeeRouter ?? false,
    createdAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.insert(tokens).values(row);
    if (row.routeLocked) await detachTwins(tx, id, input.mint);
  });
  try {
    await ensureWebhook(await watchedAddresses());
  } catch (e) {
    console.warn(`[helius] webhook registration failed after connectToken: ${e instanceof Error ? e.message : e}`);
  }
  return (await db.select().from(tokens).where(eq(tokens.id, id)).get())!;
}

/**
 * `tokenId` has just locked its route, so it owns `mint`; every other connection of the mint was
 * unverified and can no longer be the creator's. One nothing references is deleted; one with
 * history (fee events, sweeps, allocations, a launch) is kept so that history stays attributable,
 * but marked superseded so it never counts as the mint's connection again.
 */
async function detachTwins(dbx: Dbx, tokenId: string, mint: string): Promise<void> {
  const twins = and(eq(tokens.mint, mint), ne(tokens.id, tokenId), eq(tokens.routeLocked, false), isNull(tokens.supersededAt));
  const referenced = or(
    ...[feeEvents, sweeps, deliveryAllocations, launches].map((t) => sql`exists (select 1 from ${t} where ${t.tokenId} = ${tokens.id})`),
  );
  await dbx.delete(tokens).where(and(twins, sql`not (${referenced})`));
  await dbx.update(tokens).set({ supersededAt: new Date() }).where(twins);
}

/* ------------------------------------------------------------------ */
/* Route verification                                                   */
/* ------------------------------------------------------------------ */

export interface RouteVerification {
  verified: boolean;
  locked: boolean;
  proofTx: string | null;
  method: "inflow" | "bags_config" | "none";
  reason: string;
}

/**
 * Boring and checkable: look at the last 20 transactions touching the route address.
 * If any moved value out of a pump.fun / PumpSwap fee program into it, that tx is the proof.
 * pump.fun's creator-fee redirect is one-time, so an observed inflow locks the route.
 * For Bags, the fee-share config is authoritative when we can read it; otherwise inflow only.
 */
export async function verifyRoute(tokenId: string): Promise<RouteVerification> {
  const token = await db.select().from(tokens).where(eq(tokens.id, tokenId)).get();
  if (!token) throw new LedgerError("Token not found", 404);
  if (token.supersededAt) throw new LedgerError("Another vault proved this token's fee route; this connection is superseded", 409);

  let proofTx: string | null = null;
  try {
    const conn = rpc();
    const sigs = await conn.getSignaturesForAddress(new PublicKey(token.routeAddress), { limit: 20 }, "confirmed");
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) continue;
      const programs = new Set<string>();
      for (const ix of tx.transaction.message.instructions) programs.add(ix.programId.toBase58());
      for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) programs.add(ix.programId.toBase58());
      const fromFeeProgram = [...programs].some((p) => FEE_SOURCE_PROGRAMS[p]);
      if (!fromFeeProgram) continue;
      const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === token.routeAddress);
      const gained = idx >= 0 && tx.meta && tx.meta.postBalances[idx] > tx.meta.preBalances[idx];
      if (gained) {
        proofTx = s.signature;
        break;
      }
    }
  } catch (e) {
    return { verified: !!token.routeProofTx, locked: token.routeLocked, proofTx: token.routeProofTx, method: "none", reason: `RPC lookup failed: ${e instanceof Error ? e.message : e}` };
  }

  let method: RouteVerification["method"] = proofTx ? "inflow" : "none";
  let locked = false;
  let reason = proofTx ? "Fee inflow from a launchpad fee program observed on the route address." : "No launchpad fee inflow found in the last 20 transactions.";

  if (token.source === "pumpfun" && proofTx) locked = true;
  if (token.source === "bags") {
    const claimers = await getBagsFeeShareClaimers(token.mint);
    if (claimers) {
      const hit = claimers.find((c) => c.wallet === token.routeAddress);
      if (hit) {
        locked = true;
        method = "bags_config";
        reason = `Bags fee-share config lists the route address at ${hit.bps} bps.`;
        if (hit.bps !== token.routeBps) await db.update(tokens).set({ routeBps: hit.bps }).where(eq(tokens.id, tokenId));
      } else {
        reason = "Bags fee-share config does not list the route address." + (proofTx ? " Verified by inflow only." : "");
      }
    } else if (proofTx) {
      reason += " Bags config not readable (BAGS_API_KEY unset); verified by inflow only.";
    }
  }

  const verified = !!proofTx || method === "bags_config";
  if (verified) {
    await db.transaction(async (tx) => {
      if (locked && !token.routeLocked) {
        const owner = await tx.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.mint, token.mint), eq(tokens.routeLocked, true))).get();
        if (owner) throw new LedgerError("Token already connected", 409);
        await detachTwins(tx, tokenId, token.mint);
      }
      await tx.update(tokens).set({ routeProofTx: proofTx ?? token.routeProofTx, routeLocked: locked || token.routeLocked }).where(eq(tokens.id, tokenId));
    });
  }
  return { verified, locked: locked || token.routeLocked, proofTx: proofTx ?? token.routeProofTx, method, reason };
}

/* ------------------------------------------------------------------ */
/* Periods                                                              */
/* ------------------------------------------------------------------ */

/** Σ fee USD that landed in [start, end), cents-rounded: what a period freezes when it closes. */
async function periodFeesUsd(vaultId: string, start: Date, end: Date): Promise<number> {
  const fees = (await db.select({ usd: sum(feeEvents.amountUsd) }).from(feeEvents).where(and(eq(feeEvents.vaultId, vaultId), sql`${feeEvents.blockTime} >= ${start.getTime()}`, sql`${feeEvents.blockTime} < ${end.getTime()}`)).get())!.usd;
  return Math.round(fees * 100) / 100;
}

/** Weekly periods, created lazily and contiguously from the vault's first day (UTC). */
export async function ensureOpenPeriod(vaultId: string, now = new Date()): Promise<Period> {
  const rows = await db.select().from(periods).where(eq(periods.vaultId, vaultId)).orderBy(desc(periods.startsAt)).limit(1);
  let last = rows[0];
  if (last && last.startsAt <= now && now < last.endsAt) {
    if (last.status !== "open") await db.update(periods).set({ status: "open" }).where(eq(periods.id, last.id));
    return { ...last, status: "open" };
  }
  let start: Date;
  let n: number;
  if (last) {
    // Whoever notices the window ended first closes it, so it must freeze the fees here too: closePeriods skips closed rows.
    if (last.status !== "closed") await db.update(periods).set({ status: "closed", feesUsd: await periodFeesUsd(vaultId, last.startsAt, last.endsAt) }).where(eq(periods.id, last.id));
    start = last.endsAt;
    n = Number(last.label.replace(/\D/g, "")) || (await db.select({ n: sql<number>`count(*)` }).from(periods).where(eq(periods.vaultId, vaultId)).get())!.n;
  } else {
    const v = await db.select({ createdAt: vaults.createdAt }).from(vaults).where(eq(vaults.id, vaultId)).get();
    if (!v) throw new LedgerError("Vault not found", 404);
    start = new Date(Date.UTC(v.createdAt.getUTCFullYear(), v.createdAt.getUTCMonth(), v.createdAt.getUTCDate()));
    n = 0;
  }
  while (true) {
    n++;
    const end = new Date(start.getTime() + WEEK_MS);
    const covers = start <= now && now < end;
    const fees = covers ? 0 : await periodFeesUsd(vaultId, start, end);
    const row: typeof periods.$inferInsert = { id: newId("per"), vaultId, label: `Week ${n}`, startsAt: start, endsAt: end, status: covers ? "open" : "closed", feesUsd: fees, deliveredUsd: 0, createdAt: now };
    await db.insert(periods).values(row);
    last = (await db.select().from(periods).where(eq(periods.id, row.id)).get())!;
    if (covers) return last;
    start = end;
  }
}

/** Close every period whose window has ended, freezing its fee total, and open the current one. */
export async function closePeriods(vaultId: string, now = new Date()): Promise<{ closed: number; open: Period }> {
  const stale = await db.select().from(periods).where(and(eq(periods.vaultId, vaultId), inArray(periods.status, ["open", "closing"]), sql`${periods.endsAt} <= ${now.getTime()}`));
  for (const p of stale) {
    await db.update(periods).set({ status: "closed", feesUsd: await periodFeesUsd(vaultId, p.startsAt, p.endsAt) }).where(eq(periods.id, p.id));
  }
  const open = await ensureOpenPeriod(vaultId, now);
  return { closed: stale.length, open };
}

/* ------------------------------------------------------------------ */
/* Deliverable balance                                                  */
/* ------------------------------------------------------------------ */

export interface Deliverable {
  /** What may be queued right now, in USD, cents-rounded. Alias of `deliverableUsd` for existing readers. */
  totalUsd: number;
  deliverableUsd: number;
  /** Σ SOL/USDC fees × donateBps − counted allocations. */
  ledgerUsd: number;
  /** The vault treasury's on-chain USDC balance; null without a configured RPC (or when the lookup failed). */
  treasuryUsd: number | null;
  /** Which bound produced `deliverableUsd`. `treasury` = balance − queued/funding amounts is below the ledger view. */
  cappedBy: "ledger" | "treasury";
  perToken: { tokenId: string; symbol: string; undeliveredUsd: number }[];
  inFlight: number;
}

interface LedgerView {
  perToken: Deliverable["perToken"];
  inFlight: number;
  ledgerUsd: number;
  /** Amount of deliveries whose USDC has not (certainly) left the treasury yet. */
  pendingUsd: number;
}

/** Ledger-only view, readable inside a transaction so `queueDelivery` allocates against a snapshot it also writes to. */
async function ledgerView(vaultId: string, dbx: Dbx): Promise<LedgerView> {
  const vault = await dbx.select({ donateBps: vaults.donateBps }).from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!vault) throw new LedgerError("Vault not found", 404);
  const share = vault.donateBps / 10000;

  const toks = await dbx.select({ id: tokens.id, symbol: tokens.symbol }).from(tokens).where(eq(tokens.vaultId, vaultId));
  const fees = await dbx
    .select({ tokenId: feeEvents.tokenId, usd: sum(feeEvents.amountUsd) })
    .from(feeEvents)
    .where(and(eq(feeEvents.vaultId, vaultId), inArray(feeEvents.assetMint, VALUED_MINTS)))
    .groupBy(feeEvents.tokenId);
  const allocated = await dbx
    .select({ tokenId: deliveryAllocations.tokenId, usd: sum(deliveryAllocations.amountUsdc) })
    .from(deliveryAllocations)
    .innerJoin(deliveries, eq(deliveries.id, deliveryAllocations.deliveryId))
    .where(and(eq(deliveries.vaultId, vaultId), counted))
    .groupBy(deliveryAllocations.tokenId);
  const flight = await dbx
    .select({ n: sql<number>`count(*)`, pending: sql<number>`coalesce(sum(case when ${deliveries.status} in ('queued', 'funding') then ${deliveries.amountUsdc} else 0 end), 0)` })
    .from(deliveries)
    .where(and(eq(deliveries.vaultId, vaultId), inArray(deliveries.status, IN_FLIGHT)))
    .get();

  const feeBy: Record<string, number> = {};
  for (const f of fees) feeBy[f.tokenId] = f.usd;
  const allocBy: Record<string, number> = {};
  for (const a of allocated) allocBy[a.tokenId] = a.usd;

  const perToken = toks.map((t) => {
    const c = Math.max(0, cents((feeBy[t.id] ?? 0) * share) - cents(allocBy[t.id] ?? 0));
    return { tokenId: t.id, symbol: t.symbol, undeliveredUsd: c / 100 };
  });
  const ledgerUsd = perToken.reduce((a, t) => a + cents(t.undeliveredUsd), 0) / 100;
  return { perToken, inFlight: flight?.n ?? 0, ledgerUsd, pendingUsd: flight?.pending ?? 0 };
}

/**
 * On-chain USDC in the vault treasury, or null when no RPC is configured. `strict` turns a failed
 * lookup into a 503 instead of null: queueing must not fall back to the ledger view when the
 * treasury cannot be checked, since the ledger alone is what an attacker can inflate.
 */
async function treasuryBalance(treasuryAddress: string, strict: boolean): Promise<number | null> {
  if (!configured.rpc) return null;
  try {
    return await usdcBalance(treasuryAddress);
  } catch (e) {
    if (strict) throw new LedgerError(`Treasury balance unavailable: ${e instanceof Error ? e.message : String(e)}`, 503);
    console.warn(`[ledger] treasury balance lookup failed for ${treasuryAddress}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function combine(view: LedgerView, treasuryUsd: number | null): Deliverable {
  const ledgerCents = cents(view.ledgerUsd);
  const treasuryCents = treasuryUsd === null ? null : Math.max(0, cents(treasuryUsd) - cents(view.pendingUsd));
  const cappedBy = treasuryCents !== null && treasuryCents < ledgerCents ? "treasury" : "ledger";
  const deliverableUsd = (cappedBy === "treasury" ? treasuryCents! : ledgerCents) / 100;
  return { totalUsd: deliverableUsd, deliverableUsd, ledgerUsd: view.ledgerUsd, treasuryUsd, cappedBy, perToken: view.perToken, inFlight: view.inFlight };
}

export async function deliverable(vaultId: string): Promise<Deliverable> {
  const vault = await db.select({ treasuryAddress: vaults.treasuryAddress }).from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!vault) throw new LedgerError("Vault not found", 404);
  const [view, treasuryUsd] = await Promise.all([ledgerView(vaultId, db), treasuryBalance(vault.treasuryAddress, false)]);
  return combine(view, treasuryUsd);
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                           */
/* ------------------------------------------------------------------ */

/**
 * Queue a delivery of min(requested, deliverable) to a verified cause. Allocations are pro-rata by
 * each token's undelivered fee balance, computed in integer cents (largest remainder), so they
 * always sum exactly to amountUsdc and no token is charged more than its own balance. The balance
 * is read and the row written in one transaction, under the vault's process lock, so two callers
 * cannot both allocate the same cents.
 */
export async function queueDelivery(vaultId: string, amountUsdc: number): Promise<Delivery> {
  if (!(amountUsdc > 0)) throw new LedgerError("Amount must be positive");
  return withLock(`vault:${vaultId}`, async () => {
    const vault = await db.select().from(vaults).where(eq(vaults.id, vaultId)).get();
    if (!vault) throw new LedgerError("Vault not found", 404);
    if (vault.status !== "active") throw new LedgerError(`Vault is ${vault.status}`, 409);
    const cause = await db.select().from(causes).where(eq(causes.id, vault.causeId)).get();
    if (!cause) throw new LedgerError("Cause not found", 404);
    if (cause.verificationStatus !== "verified") throw new LedgerError(`Cause is ${cause.verificationStatus}; only verified causes receive deliveries`, 409);

    // Network reads stay outside the write transaction.
    const treasuryUsd = await treasuryBalance(vault.treasuryAddress, true);
    const period = await ensureOpenPeriod(vaultId);
    const rail = railForCause(cause).id;
    const id = newId("dlv");
    const now = new Date();

    await db.transaction(async (tx) => {
      const d = combine(await ledgerView(vaultId, tx), treasuryUsd);
      const amountCents = Math.min(cents(amountUsdc), cents(d.deliverableUsd));
      if (amountCents <= 0) {
        if (d.cappedBy === "treasury" && cents(d.ledgerUsd) > 0) throw new LedgerError(`Nothing deliverable: treasury holds $${(d.treasuryUsd ?? 0).toFixed(2)} USDC against $${d.ledgerUsd.toFixed(2)} attributed; sweep first`, 409);
        throw new LedgerError("Nothing deliverable: all attributed fees are already delivered or in flight", 409);
      }

      // Floor every share, then give the leftover cents to the largest remainders. A share only rounds up
      // when it had a remainder, i.e. amount < total, so floor + 1 never exceeds the token's balance.
      const basis = d.perToken.filter((t) => t.undeliveredUsd > 0).map((t) => ({ tokenId: t.tokenId, cents: BigInt(cents(t.undeliveredUsd)) }));
      const basisTotal = basis.reduce((a, t) => a + t.cents, BigInt(0));
      const shares = basis.map((t) => {
        const exact = BigInt(amountCents) * t.cents;
        return { tokenId: t.tokenId, amountCents: Number(exact / basisTotal), rem: exact % basisTotal };
      });
      let leftover = amountCents - shares.reduce((a, s) => a + s.amountCents, 0);
      for (const s of [...shares].sort((a, b) => (a.rem < b.rem ? 1 : a.rem > b.rem ? -1 : 0))) {
        if (leftover <= 0) break;
        s.amountCents += 1;
        leftover -= 1;
      }
      const allocs = shares.filter((s) => s.amountCents > 0);

      const max = (await tx.select({ m: sql<number | null>`max(${deliveries.ordinal})` }).from(deliveries).where(eq(deliveries.vaultId, vaultId)).get())?.m ?? 0;
      await tx.insert(deliveries).values({ id, ordinal: max + 1, vaultId, causeId: cause.id, periodId: period.id, rail, status: "queued", amountUsdc: amountCents / 100, queuedAt: now });
      await tx.insert(deliveryAllocations).values(allocs.map((a) => ({ deliveryId: id, tokenId: a.tokenId, amountUsdc: a.amountCents / 100 })));
    });
    return loadDelivery(id);
  });
}

async function loadDelivery(id: string): Promise<Delivery> {
  const row = await db.select().from(deliveries).where(eq(deliveries.id, id)).get();
  if (!row) throw new LedgerError("Delivery not found", 404);
  return row;
}

/**
 * Atomic status transition: one `UPDATE … WHERE status IN (from)`. True iff this call moved the row,
 * so of N concurrent callers exactly one proceeds. Every path that moves money claims first.
 */
export async function claimDelivery(deliveryId: string, from: DeliveryStatus | DeliveryStatus[], to: DeliveryStatus, set: Partial<typeof deliveries.$inferInsert> = {}): Promise<boolean> {
  const r = await db
    .update(deliveries)
    .set({ ...set, status: to })
    .where(and(eq(deliveries.id, deliveryId), inArray(deliveries.status, Array.isArray(from) ? from : [from])));
  return r.rowsAffected === 1;
}

async function claimOrThrow(deliveryId: string, from: DeliveryStatus | DeliveryStatus[], to: DeliveryStatus, set: Partial<typeof deliveries.$inferInsert> = {}): Promise<Delivery> {
  if (await claimDelivery(deliveryId, from, to, set)) return loadDelivery(deliveryId);
  const d = await loadDelivery(deliveryId);
  throw new LedgerError(`Delivery is ${d.status}, expected ${Array.isArray(from) ? from.join(" or ") : from}`, 409);
}

export interface FundingInput {
  bridgeId: string;
  bridgeDepositAddress: string;
  bridgeAmountUsdc: number;
  bridgeExpiresAt: Date;
  fundingTxSig: string;
  notes?: string | null;
}

/** operator_card: top-up invoice created and USDC sent (confirmed); waiting for Zentro to credit the card. From `queued`, or `funding` when the rail claimed the row before sending. */
export async function markFunding(deliveryId: string, input: FundingInput): Promise<Delivery> {
  return claimOrThrow(deliveryId, ["queued", "funding"], "funding", { bridgeStatus: "waiting", fundingLastValidBlockHeight: null, ...input });
}

/** Money is on the rail. From `queued`/`funding` (onchain: the transfer is the delivery; card: Zentro credited it). */
export async function markFunded(deliveryId: string, fundingTxSig: string, bridgeStatus?: string): Promise<Delivery> {
  return claimOrThrow(deliveryId, ["queued", "funding"], "funded", { fundingTxSig, fundingLastValidBlockHeight: null, fundedAt: new Date(), ...(bridgeStatus === undefined ? {} : { bridgeStatus }) });
}

/**
 * A funding transfer threw after the row was claimed. Without a signature nothing left the treasury
 * and the row fails (dropping the signature recorded before a broadcast that never happened); with
 * one (e.g. confirmation timed out) the USDC may have moved, so the row stays `funding` with the
 * signature until `settleUnconfirmedFunding` reads the outcome from the chain — it must never be
 * re-queued and paid again.
 */
export async function fundingFailed(deliveryId: string, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  // `transferUsdc` attaches the signature to every failure after broadcast (as do web3.js expiry errors), and the rails to a landed transfer they could not record.
  const sig = error instanceof Error && "signature" in error && typeof error.signature === "string" ? error.signature : null;
  if (sig) {
    await db
      .update(deliveries)
      .set({ fundingTxSig: sig, notes: `Funding transfer ${sig} was sent but not confirmed: ${reason}. The worker settles it from the chain once it lands or expires.` })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "funding")));
    return;
  }
  await db.update(deliveries).set({ status: "failed", failureReason: reason, fundingTxSig: null, fundingLastValidBlockHeight: null }).where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "funding")));
}

/** operator_card: Zentro's latest word on a pending top-up (still `funding`). */
export async function updateBridgeStatus(deliveryId: string, bridgeStatus: string): Promise<void> {
  await db.update(deliveries).set({ bridgeStatus }).where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "funding")));
}

export async function markNotified(deliveryId: string): Promise<void> {
  await db.update(deliveries).set({ notifiedAt: new Date() }).where(eq(deliveries.id, deliveryId));
}

/** operator_card: the card purchase matching this delivery was found; evidence harvesting begins. */
export async function markExecuting(deliveryId: string, card: { cardTxId: string; cardTxMerchant: string; cardTxAt: Date }): Promise<Delivery> {
  return claimOrThrow(deliveryId, "funded", "executing", card);
}

/**
 * Only `queued`/`funding` rows can fail: past `funded` the cause has the money. A failed row whose
 * USDC already left the treasury (fundingTxSig set) stays counted against the balance as stranded.
 */
export async function markFailed(deliveryId: string, reason: string): Promise<Delivery> {
  if (await claimDelivery(deliveryId, ["queued", "funding"], "failed", { failureReason: reason })) return loadDelivery(deliveryId);
  const d = await loadDelivery(deliveryId);
  throw new LedgerError(`Delivery is ${d.status}; only queued or funding deliveries can be marked failed`, 409);
}

export interface RecoveryInput {
  /** The transfer that returned the stranded USDC to the vault treasury. */
  txSig: string;
  operatorUserId: string;
}

/**
 * Stranded funding came back (e.g. Zentro support refunded the top-up): release it. Only a
 * failed/reversed delivery whose USDC left the treasury, once. The cited transaction must be
 * confirmed on-chain, succeed, raise the vault treasury's USDC by at least the delivery amount and
 * not be one of our own sweeps; without an RPC nothing is recorded (503). The row keeps its status
 * and history; it only stops counting against the deliverable balance.
 */
export async function recoverStrandedFunding(deliveryId: string, input: RecoveryInput): Promise<Delivery> {
  return withLock(`delivery:${deliveryId}`, async () => {
    const d = await loadDelivery(deliveryId);
    if ((d.status !== "failed" && d.status !== "reversed") || !d.fundingTxSig) throw new LedgerError(`Delivery is ${d.status}${d.fundingTxSig ? "" : " with no funding transfer"}; only stranded funding can be recovered`, 409);
    if (d.fundingRecoveredAt) throw new LedgerError(`Funding already recovered in ${d.fundingRecoveryTxSig}`, 409);
    const reused = await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.fundingRecoveryTxSig, input.txSig)).get();
    if (reused) throw new LedgerError(`Transaction already recorded as the recovery of ${reused.id}`, 409);
    if (await db.select({ id: sweeps.id }).from(sweeps).where(eq(sweeps.txSig, input.txSig)).get()) throw new LedgerError("Transaction is a fee sweep into the treasury, not a refund", 400);
    if (!configured.rpc) throw new LedgerError("RPC not configured: a recovery is only recorded once verified on-chain", 503);

    const vault = (await db.select({ treasuryAddress: vaults.treasuryAddress }).from(vaults).where(eq(vaults.id, d.vaultId)).get())!;
    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await rpc().getParsedTransaction(input.txSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      throw new LedgerError(`Transaction lookup failed: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    if (!tx?.meta) throw new LedgerError("Transaction not found at confirmed commitment", 400);
    if (tx.meta.err) throw new LedgerError(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`, 400);
    const usdc = USDC_MINT.toBase58();
    const treasuryRaw = (balances: TokenBalance[] | null | undefined) =>
      (balances ?? []).filter((b) => b.mint === usdc && b.owner === vault.treasuryAddress).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), BigInt(0));
    const gained = treasuryRaw(tx.meta.postTokenBalances) - treasuryRaw(tx.meta.preTokenBalances);
    if (gained < toUsdcRaw(d.amountUsdc)) throw new LedgerError(`Transaction credits the treasury ${fromUsdcRaw(gained)} USDC; the stranded delivery is ${d.amountUsdc.toFixed(2)} USDC`, 400);

    const r = await db
      .update(deliveries)
      .set({ fundingRecoveredAt: new Date(), fundingRecoveryTxSig: input.txSig, fundingRecoveredBy: input.operatorUserId })
      .where(and(eq(deliveries.id, deliveryId), inArray(deliveries.status, ["failed", "reversed"]), isNotNull(deliveries.fundingTxSig), isNull(deliveries.fundingRecoveredAt)));
    if (r.rowsAffected !== 1) throw new LedgerError("Delivery changed while verifying the recovery; retry", 409);
    return loadDelivery(deliveryId);
  });
}

export interface ArtifactInput {
  kind: ReceiptArtifact["kind"];
  label: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Serialised with `finalizeDelivery`: an artifact landing between hashing and sealing would be on the public receipt but not in its hash. */
export async function attachArtifact(deliveryId: string, a: ArtifactInput): Promise<ReceiptArtifact> {
  return withLock(`delivery:${deliveryId}`, async () => {
    const d = await loadDelivery(deliveryId);
    if (d.status === "delivered" || d.status === "reversed") throw new LedgerError("Receipt is sealed; artifacts cannot be added after delivery", 409);
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new LedgerError("sha256 must be 64 lowercase hex chars");
    const dup = await db.select({ id: receiptArtifacts.id }).from(receiptArtifacts).where(and(eq(receiptArtifacts.deliveryId, deliveryId), eq(receiptArtifacts.sha256, a.sha256))).get();
    if (dup) return (await db.select().from(receiptArtifacts).where(eq(receiptArtifacts.id, dup.id)).get())!;
    const id = newId("art");
    await db.insert(receiptArtifacts).values({ id, deliveryId, kind: a.kind, label: a.label, url: a.url, sha256: a.sha256, bytes: a.bytes, createdAt: new Date() });
    return (await db.select().from(receiptArtifacts).where(eq(receiptArtifacts.id, id)).get())!;
  });
}

async function attachBytes(deliveryId: string, kind: ReceiptArtifact["kind"], label: string, body: Buffer, ext: string): Promise<ReceiptArtifact> {
  const stored = await storeBuffer(deliveryId, body, ext);
  return attachArtifact(deliveryId, { kind, label, url: stored.url, sha256: stored.sha256, bytes: stored.bytes });
}

/** Card statement line as evidence: canonical JSON (sorted keys, no whitespace) of the issuer's transaction record. */
export async function attachCardEvidence(deliveryId: string, label: string, statement: unknown): Promise<ReceiptArtifact> {
  return attachBytes(deliveryId, "card_statement", label, Buffer.from(canonicalJson(statement), "utf8"), "json");
}

/** Harvested platform confirmation email, raw RFC 822 bytes. */
export async function attachEmailEvidence(deliveryId: string, label: string, raw: Buffer): Promise<ReceiptArtifact> {
  return attachBytes(deliveryId, "confirmation_email", label, raw, "eml");
}

export interface FinalizeInput {
  railRef?: string | null;
  amountFiat?: number | null;
  fiatCurrency?: string | null;
  fxRate?: number | null;
  platformFeeFiat?: number | null;
  notes?: string | null;
  executedByUserId: string | null;
}

/**
 * Seal the receipt: apply operator-entered fiat facts, fix deliveredAt, hash the canonical
 * receipt, anchor the memo (when configured), then flip to `delivered`.
 *
 * Two guards make concurrent calls safe: the first UPDATE claims the row (`funded`/`executing`,
 * no hash yet, no live sealing lease) and the final UPDATE only counts the period when it is the
 * one that wrote the hash. Anchoring is best-effort here: a signer without SOL or a flaky RPC must
 * not leave delivered money unsealed, so the receipt is stored with `anchorTxSig = null` and the
 * worker's `anchorRetry` step anchors it later.
 */
export async function finalizeDelivery(deliveryId: string, input: FinalizeInput): Promise<Delivery> {
  return withLock(`delivery:${deliveryId}`, async () => {
    const d = await loadDelivery(deliveryId);
    if (d.status !== "funded" && d.status !== "executing") throw new LedgerError(`Delivery is ${d.status}, expected funded`, 409);
    const cause = (await db.select().from(causes).where(eq(causes.id, d.causeId)).get())!;
    const rail = railForCause(cause);
    if (rail.id !== d.rail) throw new LedgerError(`Delivery rail ${d.rail} no longer matches cause rail ${rail.id}`, 409);

    const railRef = input.railRef ?? (rail.id === "onchain" ? d.fundingTxSig : d.railRef);
    const amountFiat = input.amountFiat ?? (rail.id === "onchain" ? d.amountUsdc : d.amountFiat);
    const fiatCurrency = input.fiatCurrency ?? (rail.id === "onchain" ? "USD" : d.fiatCurrency);
    const fxRate = input.fxRate ?? (rail.id === "onchain" ? 1 : d.fxRate);
    const artifactCount = (await db.select({ n: sql<number>`count(*)` }).from(receiptArtifacts).where(eq(receiptArtifacts.deliveryId, deliveryId)).get())!.n;

    for (const req of rail.finalizeRequirements(d)) {
      if (req === "railRef" && !railRef) throw new LedgerError("railRef is required for this rail");
      if (req === "amountFiat" && !(typeof amountFiat === "number" && amountFiat > 0)) throw new LedgerError("amountFiat is required for this rail");
      if (req === "artifacts" && artifactCount === 0) throw new LedgerError("At least one artifact (screenshot, confirmation, statement) is required for this rail");
    }

    const deliveredAt = new Date();
    const claimed = await db
      .update(deliveries)
      .set({ status: "executing", railRef, amountFiat, fiatCurrency, fxRate, platformFeeFiat: input.platformFeeFiat ?? d.platformFeeFiat, notes: input.notes ?? d.notes, executedByUserId: input.executedByUserId, deliveredAt })
      .where(
        and(
          eq(deliveries.id, deliveryId),
          inArray(deliveries.status, ["funded", "executing"]),
          sql`${deliveries.receiptHash} is null`,
          sql`(${deliveries.deliveredAt} is null or ${deliveries.deliveredAt} < ${deliveredAt.getTime() - SEAL_LEASE_MS})`,
        ),
      );
    if (claimed.rowsAffected !== 1) throw new LedgerError("Delivery is already being sealed", 409);

    const detail = (await getReceipt(deliveryId))!;
    const hash = receiptHash(canonicalReceipt(detail));
    let anchorTxSig: string | null = null;
    try {
      anchorTxSig = await anchorMemo(memoFor(deliveryId, hash));
    } catch (e) {
      console.warn(`[anchor] ${deliveryId}: anchoring failed, receipt sealed unanchored (worker retries): ${e instanceof Error ? e.message : e}`);
    }

    await db.transaction(async (tx) => {
      const sealed = await tx
        .update(deliveries)
        .set({ status: "delivered", receiptHash: hash, anchorTxSig })
        .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "executing"), sql`${deliveries.receiptHash} is null`));
      if (sealed.rowsAffected !== 1) throw new LedgerError("Delivery was sealed by another call", 409);
      if (d.periodId) await tx.update(periods).set({ deliveredUsd: sql`round(${periods.deliveredUsd} + ${d.amountUsdc}, 2)` }).where(eq(periods.id, d.periodId));
    });
    return loadDelivery(deliveryId);
  });
}

export interface AnchorRetryResult {
  /** Delivered receipts still lacking an anchor after this pass. */
  pending: number;
  anchored: string[];
  errors: string[];
}

/** Anchor delivered receipts whose memo never landed (signer unfunded, RPC down at seal time). At most `limit` per call. */
export async function retryAnchors(limit = 20): Promise<AnchorRetryResult> {
  const rows = await db
    .select({ id: deliveries.id, receiptHash: deliveries.receiptHash })
    .from(deliveries)
    .where(and(eq(deliveries.status, "delivered"), sql`${deliveries.anchorTxSig} is null`, sql`${deliveries.receiptHash} is not null`))
    .orderBy(deliveries.deliveredAt)
    .limit(limit + 1);
  const batch = rows.slice(0, limit);
  const result: AnchorRetryResult = { pending: rows.length, anchored: [], errors: [] };
  for (const r of batch) {
    try {
      const sig = await anchorMemo(memoFor(r.id, r.receiptHash!));
      if (!sig) break; // not configured: the same answer for every row
      const w = await db.update(deliveries).set({ anchorTxSig: sig }).where(and(eq(deliveries.id, r.id), sql`${deliveries.anchorTxSig} is null`));
      if (w.rowsAffected === 1) {
        result.anchored.push(r.id);
        result.pending -= 1;
      }
    } catch (e) {
      result.errors.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
