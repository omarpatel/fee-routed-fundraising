import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { causes, googleTokens, keys, launches, protocolFeeEvents, protocolForwards, users, vaults, type User, type Vault } from "@/lib/db/schema";
import { configured, env } from "@/lib/env";
import { generateKey, loadKeypair } from "@/lib/keys";
import { createPumpToken, pumpCreateBudgetSol, pumpfunCreatorRewardsUrl } from "@/lib/launchpads/pumpfun";
import { finishLaunch, fundLaunch, mergeLaunchMeta, unresolvedLaunch, type LaunchMeta } from "@/lib/launchpads/recovery";
import { createCause, createVault, LedgerError } from "@/lib/ledger";
import { watchedAddresses } from "@/lib/ledger/ingest";
import { ensureWebhook } from "@/lib/solana/helius";
import { solBalance, usdcBalance } from "@/lib/solana/transfer";
import type { ImageBytes } from "@/lib/uploads";
import { getProtocolConfig, setProtocolConfigIfAbsent } from "./config";
import { PROTOCOL_LAUNCH_MIN_SOL, PROTOCOL_SPLIT, PROTOCOL_TOKEN } from "./token";

export { getProtocolConfig } from "./config";
export { PROTOCOL_SPLIT, PROTOCOL_TOKEN } from "./token";

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Protocol treasury                                                    */
/* ------------------------------------------------------------------ */

/**
 * The single address that receives $ROUTE creator fees (and anything else sent to the protocol).
 * Created once under KMS; the address is pinned in `protocol_config` so it never silently changes.
 * Registers itself with the Helius webhook when Helius is configured (best effort, logged).
 */
export async function ensureProtocolTreasury(): Promise<string> {
  const existing = await getProtocolConfig("protocol_treasury_address");
  if (existing) return existing;
  if (!configured.kms) throw new LedgerError("FEE_ROUTER_KMS_KEY is not configured; the protocol treasury key cannot be created", 503);
  const { address } = await generateKey("protocol_treasury", "protocol");
  const stored = await setProtocolConfigIfAbsent("protocol_treasury_address", address);
  if (stored !== address) {
    // Lost a race with a concurrent ensure; the pinned address wins and the orphan key is dropped.
    await db.delete(keys).where(eq(keys.address, address));
    return stored;
  }
  try {
    await ensureWebhook(await watchedAddresses());
  } catch (e) {
    console.warn(`[helius] webhook registration failed after ensureProtocolTreasury: ${e instanceof Error ? e.message : e}`);
  }
  return address;
}

export interface ProtocolStats {
  treasuryAddress: string | null;
  protocolMint: string | null;
  protocolLaunchId: string | null;
  /** Live RPC balances; null when unavailable, with the reason in `balancesError`. */
  balances: { sol: number; usdc: number } | null;
  balancesError: string | null;
  feesUsd7d: number;
  feesUsd30d: number;
  feesUsdAll: number;
  lastEventAt: Date | null;
  eventCount: number;
  /** Commons share of treasury fee claims: landed on the Commons route, and owed (pending or in flight), in SOL. */
  commonsForwardedSol: number;
  commonsOwedSol: number;
}

export async function protocolStats(): Promise<ProtocolStats> {
  const now = Date.now();
  const sum = sql<number>`coalesce(sum(${protocolFeeEvents.amountUsd}), 0)`;
  const [treasuryAddress, protocolMint, protocolLaunchId, all, d7, d30, forwards] = await Promise.all([
    getProtocolConfig("protocol_treasury_address"),
    getProtocolConfig("protocol_mint"),
    getProtocolConfig("protocol_launch_id"),
    db.select({ usd: sum, n: sql<number>`count(*)`, last: sql<number | null>`max(${protocolFeeEvents.blockTime})` }).from(protocolFeeEvents).get(),
    db.select({ usd: sum }).from(protocolFeeEvents).where(gte(protocolFeeEvents.blockTime, new Date(now - 7 * DAY_MS))).get(),
    db.select({ usd: sum }).from(protocolFeeEvents).where(gte(protocolFeeEvents.blockTime, new Date(now - 30 * DAY_MS))).get(),
    db
      .select({
        forwarded: sql<number>`coalesce(sum(case when ${protocolForwards.status} = 'confirmed' then cast(${protocolForwards.forwardLamports} as integer) end), 0)`,
        owed: sql<number>`coalesce(sum(case when ${protocolForwards.status} in ('pending', 'sent') then cast(${protocolForwards.forwardLamports} as integer) end), 0)`,
      })
      .from(protocolForwards)
      .get(),
  ]);

  let balances: ProtocolStats["balances"] = null;
  let balancesError: string | null = null;
  if (!treasuryAddress) balancesError = "Treasury not created";
  else if (!configured.rpc) balancesError = "RPC not configured";
  else {
    try {
      const [sol, usdc] = await Promise.all([solBalance(treasuryAddress), usdcBalance(treasuryAddress)]);
      balances = { sol, usdc };
    } catch (e) {
      balancesError = `RPC error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    treasuryAddress,
    protocolMint,
    protocolLaunchId,
    balances,
    balancesError,
    feesUsd7d: d7?.usd ?? 0,
    feesUsd30d: d30?.usd ?? 0,
    feesUsdAll: all?.usd ?? 0,
    lastEventAt: all?.last ? new Date(all.last) : null,
    eventCount: all?.n ?? 0,
    commonsForwardedSol: (forwards?.forwarded ?? 0) / 1e9,
    commonsOwedSol: (forwards?.owed ?? 0) / 1e9,
  };
}

/** Recent treasury inflows for the admin ledger. */
export function listProtocolFeeEvents(limit = 20) {
  return db.select().from(protocolFeeEvents).orderBy(desc(protocolFeeEvents.blockTime)).limit(limit);
}

/* ------------------------------------------------------------------ */
/* Commons vault                                                        */
/* ------------------------------------------------------------------ */

export const COMMONS_VAULT_SLUG = "commons";
const COMMONS_CAUSE_SLUG = "fee-router-commons";

/**
 * The vault that receives the Commons share of $ROUTE fees. Its cause is the rotating "Fee Router
 * Commons" cause (platform `other`, verified by construction: it is the protocol itself). Created
 * lazily by the first admin action that needs it; idempotent on slug.
 */
export async function ensureCommonsVault(adminUserId: string): Promise<Vault> {
  const existing = await db.select().from(vaults).where(eq(vaults.slug, COMMONS_VAULT_SLUG)).get();
  if (existing) return existing;
  const site = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  let cause = await db.select().from(causes).where(eq(causes.slug, COMMONS_CAUSE_SLUG)).get();
  if (!cause) {
    cause = await createCause({
      slug: COMMONS_CAUSE_SLUG,
      title: "Fee Router Commons",
      summary: "The matching pool. $ROUTE holders choose which verified cause receives the Commons flow each period.",
      story:
        "The Commons vault receives half of the creator fees from $ROUTE. Each period, holders vote on which verified cause the Commons funds, and the match is delivered on that cause's rail with its own receipt. This cause is a placeholder for the rotation: the money always leaves through a verified cause, never to Fee Router.",
      beneficiary: "Verified causes chosen by $ROUTE holders",
      platform: "other",
      url: `${site}/docs`,
      category: "other",
      createdBy: adminUserId,
    });
    await db.update(causes).set({ verificationStatus: "verified", verificationNote: "Protocol-owned rotation cause; deliveries are matched to verified causes chosen by $ROUTE holders.", verifiedAt: new Date() }).where(eq(causes.id, cause.id));
  }
  return createVault({ slug: COMMONS_VAULT_SLUG, name: "Fee Router Commons", tagline: "Matches deliveries for vaults that launch under Fee Router.", causeId: cause.id, ownerUserId: adminUserId });
}

/* ------------------------------------------------------------------ */
/* $ROUTE launch                                                        */
/* ------------------------------------------------------------------ */

export interface LaunchProtocolInput {
  name?: string;
  symbol?: string;
  description: string;
  /** Uploaded through /api/uploads; the bytes go to pump.fun's metadata store. */
  imageUrl: string;
  image: ImageBytes;
  /** SOL the treasury spends on the initial buy. */
  devBuySol: number;
  /** The admin whose custodial wallet pays: it funds the treasury with devBuy + reserve before the create. */
  payerUserId: string;
}

export interface LaunchProtocolResult {
  launchId: string;
  mint: string;
  /** The protocol treasury: creator of the token and permanent recipient of its creator fees. */
  creator: string;
  signatures: string[];
  commonsVaultSlug: string;
  launchpadUrl: string;
  split: typeof PROTOCOL_SPLIT;
}

/**
 * Launch $ROUTE on pump.fun with the protocol treasury as the token's creator. pump.fun pays creator
 * fees to the creator wallet, so 100% of the creator share lands on the treasury by construction;
 * the Commons / treasury split in `PROTOCOL_SPLIT` is applied by the treasury after the fact
 * (Commons share forwarded to the Commons vault's route address as fee events) and is a stated
 * policy, not an on-chain fee-share config.
 *
 * The admin's custodial wallet funds the treasury with devBuy + rent reserve; the treasury key signs
 * the create transaction together with the new mint key. Refuses to run twice: `protocol_mint` is
 * pinned in protocol config on success. If the request cannot finish, `launchRecoveryStep` registers
 * the mint when it exists, otherwise refunds the funded SOL from the treasury to the admin's wallet.
 */
export async function launchProtocolToken(input: LaunchProtocolInput): Promise<LaunchProtocolResult> {
  const already = await getProtocolConfig("protocol_mint");
  if (already) throw new LedgerError(`$ROUTE is already launched (mint ${already})`, 409);
  // An earlier attempt whose create may still land (or that awaits its refund / an operator) would make this one a second $ROUTE. Callers serialise launches (the admin route's lock), so check-then-insert is safe.
  const unresolved = await db.select({ id: launches.id, meta: launches.meta }).from(launches).where(and(sql`json_extract(${launches.meta}, '$.protocol') = 1`, unresolvedLaunch)).get();
  if (unresolved) throw new LedgerError((unresolved.meta as LaunchMeta).recovery === "manual" ? `$ROUTE launch ${unresolved.id} is held for manual review; resolve it before launching again` : `$ROUTE launch ${unresolved.id} is not resolved yet: its token may still be created, or its SOL is being refunded; launch again once it is launched or refunded`, 409);
  if (!configured.kms) throw new LedgerError("FEE_ROUTER_KMS_KEY is not configured; the admin wallet, the treasury and the Commons route key cannot be loaded or created", 503);
  if (!configured.rpc) throw new LedgerError("SOLANA_RPC_URL is not configured; launch transactions need a write-capable RPC", 503);
  if (!input.description.trim()) throw new LedgerError("Description is required");
  if (!(input.devBuySol >= 0)) throw new LedgerError("Dev buy must be zero or more SOL");

  const admin = await db.select().from(users).where(eq(users.id, input.payerUserId)).get();
  if (!admin) throw new LedgerError("Payer user not found", 404);
  if (admin.role !== "admin") throw new LedgerError("Only an admin wallet may launch $ROUTE", 403);
  const payer = await loadKeypair(admin.walletAddress);
  const budgetSol = pumpCreateBudgetSol(input.devBuySol);
  const needSol = Math.max(PROTOCOL_LAUNCH_MIN_SOL, budgetSol + 0.005);
  const solBefore = await solBalance(admin.walletAddress);
  if (solBefore < needSol) throw new LedgerError(`Admin wallet ${admin.walletAddress} holds ${solBefore.toFixed(4)} SOL; the launch needs at least ${needSol.toFixed(3)} SOL (${input.devBuySol} SOL dev buy + rent, fees and the funding transfer)`, 409);

  const treasury = await ensureProtocolTreasury();
  const creator = await loadKeypair(treasury);
  const commons = await ensureCommonsVault(admin.id);
  const name = input.name ?? PROTOCOL_TOKEN.name;
  const symbol = input.symbol ?? PROTOCOL_TOKEN.symbol;

  const launchId = `lch_${nanoid(12)}`;
  const { address: commonsRoute } = await generateKey("token_route", launchId);
  const baseMeta = { name, symbol, description: input.description, imageUrl: input.imageUrl, devBuySol: input.devBuySol, creator: treasury, routeBps: PROTOCOL_SPLIT.commonsBps, routeAddress: commonsRoute, split: PROTOCOL_SPLIT, protocol: true };
  await db.insert(launches).values({ id: launchId, userId: admin.id, vaultId: commons.id, launchpad: "pumpfun", status: "draft", meta: baseMeta, createdAt: new Date() });

  try {
    const site = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
    await fundLaunch(launchId, admin.id, payer, treasury, Math.round(budgetSol * 1e9));
    await createPumpToken({
      name,
      symbol,
      description: input.description,
      image: { bytes: input.image.body, mime: input.image.mime },
      website: `${site}/docs`,
      creator,
      devBuySol: input.devBuySol,
      onSigned: (s) => mergeLaunchMeta(launchId, { mint: s.mint, createSig: s.signature, createLastValidBlockHeight: s.lastValidBlockHeight, metadataUrl: s.metadataUri }),
    });
    // The Commons vault's token row: its route address is where the treasury forwards the Commons share.
    // Fees are attributed to the vault as they arrive there; the route itself is not pump.fun's creator.
    const { mint, signatures } = await finishLaunch(launchId);
    return { launchId, mint, creator: treasury, signatures, commonsVaultSlug: commons.slug, launchpadUrl: pumpfunCreatorRewardsUrl(mint), split: PROTOCOL_SPLIT };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(launches).set({ status: "failed", error }).where(eq(launches.id, launchId));
    throw e instanceof LedgerError ? e : new LedgerError(`Launch failed: ${error}`, 503);
  }
}

/* ------------------------------------------------------------------ */
/* Admin read models                                                    */
/* ------------------------------------------------------------------ */

export interface OperatorRow {
  user: Pick<User, "id" | "email" | "name" | "role" | "walletAddress" | "lastLoginAt">;
  gmailConnected: boolean;
}

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, walletAddress: users.walletAddress, lastLoginAt: users.lastLoginAt, scopes: googleTokens.scopes })
    .from(users)
    .leftJoin(googleTokens, eq(googleTokens.userId, users.id))
    .where(inArray(users.role, ["operator", "admin"]))
    .orderBy(users.role, users.email);
  return rows.map(({ scopes, ...user }) => ({ user, gmailConnected: !!scopes && scopes.includes("gmail") }));
}
