import { PublicKey, type Keypair } from "@solana/web3.js";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { keys, launches, tokens, users, walletTransfers, type Launch, type Token, type WalletTransfer } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { loadKeypair } from "@/lib/keys";
import { connectToken, LedgerError } from "@/lib/ledger";
import { withLock } from "@/lib/ledger/locks";
import { getProtocolConfig, setProtocolConfig } from "@/lib/protocol/config";
import { SOL_MINT, rpc } from "@/lib/solana/rpc";
import { sendOutcome, transferLamports } from "@/lib/solana/transfer";
import { pumpfunCreatorRewardsUrl } from "./pumpfun";

/**
 * A pump.fun launch moves SOL before it creates anything: the payer funds the creator key, then the
 * creator key signs the create. Each step records what it is about to broadcast in `launches.meta`
 * first, so a launch the request could not finish is resolved from the chain afterwards by
 * `launchRecoveryStep`: registered when the mint exists, refunded when the create can never land.
 * (A type alias, not an interface, so it is assignable to the `meta` column's `Record<string, unknown>`.)
 */
export type LaunchMeta = {
  name: string;
  symbol: string;
  imageUrl: string;
  routeBps: number;
  /** The token's route key: the creator itself for a user launch, the Commons route for $ROUTE. */
  routeAddress?: string;
  /** $ROUTE: `creator` is the protocol treasury, which is funded, signs the create and would refund. */
  protocol?: boolean;
  creator?: string;
  fundingSig?: string;
  fundingLastValidBlockHeight?: number;
  fundedSol?: number;
  mint?: string;
  createSig?: string;
  createLastValidBlockHeight?: number;
  metadataUrl?: string;
  signatures?: string[];
  refundSig?: string;
  /** Recovery stopped for good without a refund: `unfunded` (nothing to return) or `manual` (why in `recoveryNote`). */
  recovery?: "unfunded" | "manual";
  recoveryNote?: string;
};

/** A launch still `draft`/`config_created` after this is abandoned by its request and taken over by `launchRecoveryStep`. */
const LAUNCH_IN_FLIGHT_MS = 10 * 60_000;

/**
 * Launches that may still create a token or move SOL: in flight, or failed and not yet settled by
 * `launchRecoveryStep` (a create that can still land, a refund under way, or `manual`, which needs an
 * operator). A new launch by the same payer waits for these, or a late create could mint a second token.
 * `IS NOT` is null-safe: no marker, or `manual`, both count as unresolved; `unfunded` is settled.
 */
export const unresolvedLaunch = or(inArray(launches.status, ["draft", "config_created"]), and(eq(launches.status, "failed"), sql`json_extract(${launches.meta}, '$.recovery') is not 'unfunded'`));

/** One signature, no priority fee: what the refund transfer costs the key it drains. */
const REFUND_FEE_LAMPORTS = BigInt(5000);

/** Merge `patch` into the launch's meta in SQL (no read-modify-write), optionally setting columns in the same update. */
export async function mergeLaunchMeta(launchId: string, patch: Partial<LaunchMeta>, set: Partial<Pick<Launch, "status" | "error">> = {}): Promise<void> {
  await db
    .update(launches)
    .set({ ...set, meta: sql`json_patch(${launches.meta}, ${JSON.stringify(patch)})` })
    .where(eq(launches.id, launchId));
}

/**
 * Fund the launch's creator key from `payer` as a `launch_fee` transfer. The signature and its expiry
 * height are on the transfer row and in the launch meta before broadcast; a send whose outcome is
 * unknown leaves the row `sent` for recovery. Confirmed → launch `config_created`.
 */
export async function fundLaunch(launchId: string, userId: string, payer: Keypair, to: string, lamports: number): Promise<void> {
  const id = `wtr_${nanoid(12)}`;
  await db.insert(walletTransfers).values({ id, userId, kind: "launch_fee", assetMint: SOL_MINT, amountRaw: String(lamports), toAddress: to, status: "pending", createdAt: new Date() });
  try {
    await transferLamports(payer, to, BigInt(lamports), async (signature, lastValidBlockHeight) => {
      await db.update(walletTransfers).set({ status: "sent", txSig: signature, lastValidBlockHeight }).where(eq(walletTransfers.id, id));
      await mergeLaunchMeta(launchId, { fundingSig: signature, fundingLastValidBlockHeight: lastValidBlockHeight, fundedSol: lamports / 1e9 });
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(walletTransfers).set(e instanceof Error && "signature" in e ? { error } : { status: "failed", error }).where(eq(walletTransfers.id, id));
    throw e;
  }
  await db.update(walletTransfers).set({ status: "confirmed" }).where(eq(walletTransfers.id, id));
  await db.update(launches).set({ status: "config_created" }).where(eq(launches.id, launchId));
}

/**
 * Register the created token on the launch's vault and mark the launch `launched`: the last step of
 * a launch and of its recovery. Everything comes from the launch row. A token already on this
 * launch's route key is linked, not connected twice. $ROUTE also pins `protocol_mint`; a different
 * pinned mint is a 409 and nothing is registered.
 */
export async function finishLaunch(launchId: string): Promise<{ token: Token; mint: string; signatures: string[] }> {
  const launch = await db.select().from(launches).where(eq(launches.id, launchId)).get();
  const meta = launch?.meta as LaunchMeta | undefined;
  if (!launch || !meta?.mint || !meta.routeAddress) throw new Error(`Launch ${launchId} has no mint and route recorded`);
  const mint = meta.mint;
  if (meta.protocol) {
    const pinned = await getProtocolConfig("protocol_mint");
    if (pinned && pinned !== mint) throw new LedgerError(`$ROUTE is already launched (mint ${pinned}); ${mint} is not registered`, 409);
  }
  const token =
    (await db.select().from(tokens).where(eq(tokens.routeAddress, meta.routeAddress)).get()) ??
    (await connectToken({
      vaultId: launch.vaultId,
      mint,
      symbol: meta.symbol,
      name: meta.name,
      imageUrl: meta.imageUrl,
      source: "pumpfun",
      launchpadUrl: pumpfunCreatorRewardsUrl(mint),
      // $ROUTE: the treasury is pump.fun's creator and forwards the Commons share to the route; a user launch's route is the creator.
      creatorWallet: meta.creator ?? meta.routeAddress,
      routeBps: meta.routeBps,
      routeAddress: meta.routeAddress,
      routeLocked: !meta.protocol,
      routeProofTx: meta.createSig ?? null,
      launchedViaFeeRouter: true,
    }));
  if (meta.protocol) {
    await setProtocolConfig("protocol_mint", mint);
    await setProtocolConfig("protocol_launch_id", launchId);
  }
  const signatures = [meta.fundingSig, meta.createSig].filter((s): s is string => !!s);
  await db.update(launches).set({ status: "launched", tokenId: token.id, error: null, meta: { ...meta, signatures } }).where(eq(launches.id, launchId));
  return { token, mint, signatures };
}

/**
 * Worker step. Every pump.fun launch that failed, or sat in `draft`/`config_created` past the
 * in-flight window, is resolved from the chain:
 *   - mint account exists → `finishLaunch` (registered, `launched`)
 *   - the create can never land (on-chain failure, or unseen past its expiry height, or it was never
 *     signed) and the funding settled → refund to the launching user's wallet, launch `refunded`
 *   - otherwise wait for the next tick.
 * A refund is one `launch_refund` transfer row per launch (unique idempotency key). It only goes out
 * after its signature is written onto that row in a compare-and-set from the state it was read in,
 * so two runs can never both broadcast; an unconfirmed send is settled from the chain and re-sent
 * only once it is known never to land.
 */
export async function launchRecoveryStep(log: (m: string) => void): Promise<void> {
  if (!configured.kms) return log("skipped: FEE_ROUTER_KMS_KEY not configured");
  if (!configured.rpc) return log("skipped: SOLANA_RPC_URL not configured");
  const stale = new Date(Date.now() - LAUNCH_IN_FLIGHT_MS);
  const rows = await db
    .select()
    .from(launches)
    .where(
      and(
        eq(launches.launchpad, "pumpfun"),
        or(eq(launches.status, "failed"), and(inArray(launches.status, ["draft", "config_created"]), lt(launches.createdAt, stale))),
        sql`json_extract(${launches.meta}, '$.recovery') is null`,
      ),
    );
  for (const launch of rows) {
    try {
      await withLock(`launch-recovery:${launch.id}`, () => recoverLaunch(launch, log));
    } catch (e) {
      log(`${launch.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function recoverLaunch(launch: Launch, log: (m: string) => void): Promise<void> {
  const meta = launch.meta as LaunchMeta;
  const refundKey = `launch_refund:${launch.id}`;
  const refund = await db.select().from(walletTransfers).where(and(eq(walletTransfers.userId, launch.userId), eq(walletTransfers.idempotencyKey, refundKey))).get();
  const stop = async (recovery: "unfunded" | "manual", note: string) => {
    await mergeLaunchMeta(launch.id, { recovery, recoveryNote: note }, { status: "failed", error: launch.error ?? note });
    log(`${launch.id}: ${recovery}: ${note}`);
  };
  const refunded = async (signature: string) => {
    await mergeLaunchMeta(launch.id, { refundSig: signature }, { status: "refunded", error: launch.error ?? "The launch did not complete" });
    log(`${launch.id}: refunded (${signature})`);
  };

  if (refund?.status === "confirmed") return refunded(refund.txSig!);
  if (refund?.status === "sent") {
    const out = await sendOutcome(refund.txSig!, refund.lastValidBlockHeight);
    if (out.state === "landed") {
      await db.update(walletTransfers).set({ status: "confirmed", error: null }).where(and(eq(walletTransfers.id, refund.id), eq(walletTransfers.txSig, refund.txSig!)));
      return refunded(refund.txSig!);
    }
    // Known never to move anything: the row is free to be claimed again next tick.
    if (out.state !== "unknown") await db.update(walletTransfers).set({ status: "failed", error: out.state === "expired" ? `Refund ${refund.txSig} expired unseen` : `Refund ${refund.txSig} failed on-chain: ${JSON.stringify(out.err)}` }).where(and(eq(walletTransfers.id, refund.id), eq(walletTransfers.txSig, refund.txSig!)));
    return;
  }

  // No refund claimed yet: the create's fate decides. Once a refund row exists the create was already proven dead.
  if (!refund) {
    const conn = rpc();
    if (meta.mint) {
      const registered = meta.routeAddress ? await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.routeAddress, meta.routeAddress)).get() : undefined;
      if (registered || (await conn.getAccountInfo(new PublicKey(meta.mint), "confirmed"))) {
        try {
          const { token } = await finishLaunch(launch.id);
          log(`${launch.id}: mint ${meta.mint} is on-chain; registered as ${token.id}`);
        } catch (e) {
          if (e instanceof LedgerError && e.status === 409) return stop("manual", e.message);
          throw e;
        }
        return;
      }
    }
    if (meta.createSig) {
      // `landed` without a visible mint account yet is RPC lag; `unknown` may still land.
      const create = await sendOutcome(meta.createSig, meta.createLastValidBlockHeight ?? null);
      if (create.state === "landed" || create.state === "unknown") return;
    }
    if (meta.fundingSig) {
      const funding = await sendOutcome(meta.fundingSig, meta.fundingLastValidBlockHeight ?? null);
      if (funding.state === "unknown") return;
      await db
        .update(walletTransfers)
        .set(funding.state === "landed" ? { status: "confirmed" } : { status: "failed", error: funding.state === "expired" ? "Expired unseen" : `Failed on-chain: ${JSON.stringify(funding.err)}` })
        .where(and(eq(walletTransfers.txSig, meta.fundingSig), eq(walletTransfers.kind, "launch_fee"), eq(walletTransfers.status, "sent")));
      if (meta.protocol && funding.state !== "landed") return stop("unfunded", "The funding transfer never landed");
    } else if (meta.protocol) return stop("unfunded", "The launch failed before its funding transfer was signed");
    // Before signatures were recorded ahead of broadcast, a missing create signature does not prove the create never went out.
    if (meta.protocol && !meta.createSig && meta.fundingLastValidBlockHeight === undefined) return stop("manual", "Launched before create signatures were recorded; check the treasury for a created mint before refunding");
  }

  // Refund. A user launch returns everything on its dedicated route key; $ROUTE returns what the treasury was funded with.
  const fromAddress = meta.protocol ? meta.creator : (meta.routeAddress ?? (await db.select({ address: keys.address }).from(keys).where(and(eq(keys.purpose, "token_route"), eq(keys.ownerId, launch.id))).get())?.address);
  if (!fromAddress) return stop("unfunded", "No creator key was created");
  const conn = rpc();
  const balance = BigInt(await conn.getBalance(new PublicKey(fromAddress), "confirmed"));
  const lamports = meta.protocol ? BigInt(Math.round((meta.fundedSol ?? 0) * 1e9)) - REFUND_FEE_LAMPORTS : balance - REFUND_FEE_LAMPORTS;
  if (lamports <= BigInt(0)) {
    if (refund) throw new Error(`refund ${refund.id}: ${fromAddress} holds ${balance} lamports, nothing left to send`);
    return stop("unfunded", `Creator key ${fromAddress} holds nothing to refund`);
  }
  if (lamports + REFUND_FEE_LAMPORTS > balance) throw new Error(`refund of ${lamports} lamports: treasury ${fromAddress} holds only ${balance}`);
  if (!refund && !meta.protocol && !meta.createSig) {
    // No create signature: rows from before it was recorded ahead of broadcast may still have created a token. The route key is dedicated, so its history is proof.
    const other = (await conn.getSignaturesForAddress(new PublicKey(fromAddress), { limit: 20 }, "confirmed")).find((s) => s.signature !== meta.fundingSig);
    if (other) return stop("manual", `Route ${fromAddress} has transaction ${other.signature} besides its funding; check for a created mint before refunding`);
  }

  const user = await db.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, launch.userId)).get();
  if (!user) throw new Error(`user ${launch.userId} not found`);
  const row: Pick<WalletTransfer, "id" | "status" | "txSig"> = refund ?? { id: `wtr_${nanoid(12)}`, status: "pending", txSig: null };
  // The unique (userId, idempotencyKey) index: a concurrent run inserting the same claim throws here.
  if (!refund) await db.insert(walletTransfers).values({ id: row.id, userId: launch.userId, kind: "launch_refund", assetMint: SOL_MINT, amountRaw: String(lamports), toAddress: user.walletAddress, status: "pending", idempotencyKey: refundKey, createdAt: new Date() });

  // The claimed signature, for the failure path; a holder because TypeScript does not track assignments made inside the callback.
  const claim: { sig: string | null } = { sig: null };
  let signature: string;
  try {
    signature = await transferLamports(await loadKeypair(fromAddress), user.walletAddress, lamports, async (sig, lastValidBlockHeight) => {
      const claimed = await db
        .update(walletTransfers)
        .set({ status: "sent", txSig: sig, lastValidBlockHeight, amountRaw: String(lamports), error: null })
        .where(and(eq(walletTransfers.id, row.id), eq(walletTransfers.status, row.status), row.txSig ? eq(walletTransfers.txSig, row.txSig) : isNull(walletTransfers.txSig)));
      if (claimed.rowsAffected !== 1) throw new Error(`refund ${row.id} was claimed by another run`);
      claim.sig = sig;
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Not claimed: this run broadcast nothing. Claimed and no signature on the error: RPC rejection or on-chain failure, nothing moved.
    if (claim.sig) await db.update(walletTransfers).set(e instanceof Error && "signature" in e ? { error } : { status: "failed", error }).where(and(eq(walletTransfers.id, row.id), eq(walletTransfers.txSig, claim.sig)));
    throw e;
  }
  await db.update(walletTransfers).set({ status: "confirmed" }).where(and(eq(walletTransfers.id, row.id), eq(walletTransfers.txSig, signature)));
  return refunded(signature);
}
