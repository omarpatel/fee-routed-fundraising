import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { launches, protocolForwards, tokens } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { loadKeypair } from "@/lib/keys";
import type { LaunchMeta } from "@/lib/launchpads/recovery";
import { withLock } from "@/lib/ledger/locks";
import { PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMPFUN_PROGRAM_ID, SOL_MINT, rpc } from "@/lib/solana/rpc";
import { sendOutcome, transferLamports } from "@/lib/solana/transfer";
import { getProtocolConfig } from "./config";
import { PROTOCOL_SPLIT } from "./token";

/**
 * The Commons share of $ROUTE creator fees. pump.fun pays 100% of them to the protocol treasury (the
 * token's creator); `recordProtocolClaims` books each claim that landed there as a `protocol_forwards`
 * row owing `PROTOCOL_SPLIT.commonsBps` of what it brought in, and `forwardCommonsShare` sends what is owed
 * to the Commons vault's route address in one transfer, where ingest books it as a Commons fee event
 * and the sweep converts it. The treasury share simply stays in the treasury.
 */

/** Programs a creator fee claim runs through: pump.fun (bonding curve), its fee program, PumpSwap (graduated). */
const CLAIM_PROGRAMS: Record<string, true> = { [PUMPFUN_PROGRAM_ID]: true, [PUMP_FEE_PROGRAM_ID]: true, [PUMP_AMM_PROGRAM_ID]: true };
/** How far back discovery looks when nothing stops it earlier. */
const MAX_SIGNATURES = 1000;
const PAGE = 100;
/** Below this the batch waits for more claims. */
const MIN_FORWARD_LAMPORTS = BigInt(10_000_000);
/** Kept on the treasury on top of its rent-exempt minimum, for fees. */
const FEE_BUFFER_LAMPORTS = BigInt(5_000_000);

const sol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

/** Treasury, Commons route and $ROUTE create signature; a string says why forwarding cannot run yet. */
async function forwardTarget(): Promise<{ treasury: string; route: string; createSig: string | null } | string> {
  const [mint, treasury, launchId] = await Promise.all([getProtocolConfig("protocol_mint"), getProtocolConfig("protocol_treasury_address"), getProtocolConfig("protocol_launch_id")]);
  if (!mint || !treasury) return "$ROUTE not launched";
  if (!launchId) return "$ROUTE was launched outside Fee Router; creator fees are handled manually";
  const launch = await db.select({ meta: launches.meta }).from(launches).where(eq(launches.id, launchId)).get();
  const meta = launch?.meta as LaunchMeta | undefined;
  if (!meta?.routeAddress) return `$ROUTE launch ${launchId} has no Commons route recorded`;
  const token = await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.routeAddress, meta.routeAddress)).get();
  if (!token) return `no Commons token row on route ${meta.routeAddress}`;
  return { treasury, route: meta.routeAddress, createSig: meta.createSig ?? null };
}

/**
 * What a successful transaction invoking a creator fee program brought into `owner`: its SOL change
 * (the fee added back when it paid it) plus its wrapped SOL change. 0 for anything else.
 */
function claimGain(tx: VersionedTransactionResponse, owner: string): bigint {
  const { meta, transaction } = tx;
  const zero = BigInt(0);
  if (!meta || meta.err) return zero;
  const { message } = transaction;
  const keys = [...message.staticAccountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])].map((k) => k.toBase58());
  const programs = [...message.compiledInstructions, ...(meta.innerInstructions ?? []).flatMap((i) => i.instructions)].map((ix) => keys[ix.programIdIndex]);
  if (!programs.some((p) => CLAIM_PROGRAMS[p])) return zero;
  const at = keys.indexOf(owner);
  let gain = at < 0 ? zero : BigInt(meta.postBalances[at]) - BigInt(meta.preBalances[at]) + (at === 0 ? BigInt(meta.fee) : zero);
  for (const b of meta.postTokenBalances ?? []) if (b.mint === SOL_MINT && b.owner === owner) gain += BigInt(b.uiTokenAmount.amount);
  for (const b of meta.preTokenBalances ?? []) if (b.mint === SOL_MINT && b.owner === owner) gain -= BigInt(b.uiTokenAmount.amount);
  return gain;
}

/**
 * Book every creator fee claim on the protocol treasury not booked yet, whoever sent it (the worker,
 * or an operator from pump.fun's UI). Walks the treasury's history newest → oldest until the newest
 * booked claim, the $ROUTE create transaction or `MAX_SIGNATURES`, then books oldest first; a
 * transaction the RPC cannot return yet stops the run so nothing newer is booked past it. A claim is a
 * successful transaction invoking a pump program in which the treasury gained SOL; the create and dev
 * buy spend it, and funding transfers and refunds invoke no pump program. Idempotent on `claimSig`.
 * Returns how many claims were booked.
 */
export async function recordProtocolClaims(): Promise<number> {
  if (!configured.rpc) return 0;
  const target = await forwardTarget();
  if (typeof target === "string") return 0;
  const conn = rpc();
  const owner = new PublicKey(target.treasury);
  const candidates: string[] = [];
  let before: string | undefined;
  let scanned = 0;
  scan: while (scanned < MAX_SIGNATURES) {
    const limit = Math.min(PAGE, MAX_SIGNATURES - scanned);
    const page = await conn.getSignaturesForAddress(owner, { before, limit }, "confirmed");
    if (page.length === 0) break;
    const booked = new Set((await db.select({ sig: protocolForwards.claimSig }).from(protocolForwards).where(inArray(protocolForwards.claimSig, page.map((s) => s.signature)))).map((r) => r.sig));
    for (const s of page) {
      if (s.signature === target.createSig || booked.has(s.signature)) break scan;
      scanned++;
      if (!s.err) candidates.push(s.signature);
    }
    if (page.length < limit) break;
    before = page[page.length - 1].signature;
  }

  let recorded = 0;
  for (const claimSig of candidates.reverse()) {
    const tx = await conn.getTransaction(claimSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) break;
    const gain = claimGain(tx, target.treasury);
    if (gain <= BigInt(0)) continue;
    const now = new Date();
    const forward = (gain * BigInt(PROTOCOL_SPLIT.commonsBps)) / BigInt(10_000);
    const r = await db
      .insert(protocolForwards)
      .values({ id: `pfw_${nanoid(12)}`, claimSig, claimedLamports: gain.toString(), forwardLamports: forward.toString(), toAddress: target.route, status: "pending", createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: protocolForwards.claimSig })
      .returning({ id: protocolForwards.id });
    recorded += r.length;
  }
  return recorded;
}

/**
 * Send the Commons share owed on booked claims from the treasury to the Commons route. First settles
 * transfers already `sent` from the chain: landed → `confirmed`; failed or expired → back to `pending`
 * (nothing moved); unknown → left, and nothing new is sent until it settles. Then every `pending` row
 * goes out in one transfer once they total ≥ 0.01 SOL and the treasury keeps its rent-exempt minimum
 * plus a fee buffer. The rows flip to `sent` with the signature before broadcast, all or none.
 */
export async function forwardCommonsShare(log: (m: string) => void): Promise<void> {
  if (!configured.kms || !configured.rpc) return log("skipped: needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL");
  const target = await forwardTarget();
  if (typeof target === "string") return log(`skipped: ${target}`);
  const { treasury, route } = target;

  await withLock("protocol:forward", async () => {
    const sent = await db.selectDistinct({ txSig: protocolForwards.txSig, lastValidBlockHeight: protocolForwards.lastValidBlockHeight }).from(protocolForwards).where(eq(protocolForwards.status, "sent"));
    let unsettled = 0;
    for (const { txSig, lastValidBlockHeight } of sent) {
      if (!txSig) continue;
      const o = await sendOutcome(txSig, lastValidBlockHeight);
      const set =
        o.state === "landed"
          ? { status: "confirmed" as const, error: null }
          : o.state === "unknown"
            ? null
            : { status: "pending" as const, txSig: null, lastValidBlockHeight: null, error: o.state === "failed" ? `Forward ${txSig} failed on-chain: ${JSON.stringify(o.err)}` : `Forward ${txSig} expired unseen after block ${lastValidBlockHeight}` };
      if (set) await db.update(protocolForwards).set({ ...set, updatedAt: new Date() }).where(and(eq(protocolForwards.txSig, txSig), eq(protocolForwards.status, "sent")));
      else unsettled++;
      log(`forward ${txSig}: ${o.state}`);
    }
    if (unsettled > 0) return log(`${unsettled} forward transfer(s) unconfirmed; nothing new is sent until they settle`);

    const pending = await db.select({ id: protocolForwards.id, forwardLamports: protocolForwards.forwardLamports }).from(protocolForwards).where(eq(protocolForwards.status, "pending"));
    const total = pending.reduce((a, r) => a + BigInt(r.forwardLamports), BigInt(0));
    if (pending.length === 0) return log("nothing owed to the Commons");
    if (total < MIN_FORWARD_LAMPORTS) return log(`${sol(total)} owed to the Commons over ${pending.length} claim(s); waiting for ${sol(MIN_FORWARD_LAMPORTS)}`);

    const kp = await loadKeypair(treasury);
    const conn = rpc();
    const [balance, rent] = await Promise.all([conn.getBalance(kp.publicKey, "confirmed"), conn.getMinimumBalanceForRentExemption(0)]);
    const reserve = BigInt(rent) + FEE_BUFFER_LAMPORTS;
    if (BigInt(balance) - total < reserve) return log(`treasury holds ${sol(balance)}; forwarding ${sol(total)} would leave less than its ${sol(reserve)} reserve; nothing sent`);

    const ids = pending.map((r) => r.id);
    let signed = "";
    try {
      const sig = await transferLamports(kp, route, total, async (signature, lastValidBlockHeight) => {
        await db.transaction(async (tx) => {
          const flipped = await tx
            .update(protocolForwards)
            .set({ status: "sent", txSig: signature, lastValidBlockHeight, error: null, updatedAt: new Date() })
            .where(and(inArray(protocolForwards.id, ids), eq(protocolForwards.status, "pending")))
            .returning({ id: protocolForwards.id });
          if (flipped.length !== ids.length) throw new Error(`only ${flipped.length} of ${ids.length} pending forwards were still pending; not broadcast`);
        });
        signed = signature;
      });
      await db.update(protocolForwards).set({ status: "confirmed", updatedAt: new Date() }).where(and(eq(protocolForwards.txSig, sig), eq(protocolForwards.status, "sent")));
      log(`forwarded ${sol(total)} for ${ids.length} claim(s) to the Commons route ${route} (${sig})`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // Carrying the signature means it may still land: left `sent` for the next run to settle. Otherwise nothing moved.
      if (signed) await db.update(protocolForwards).set(e instanceof Error && "signature" in e ? { error, updatedAt: new Date() } : { status: "pending", txSig: null, lastValidBlockHeight: null, error, updatedAt: new Date() }).where(and(eq(protocolForwards.txSig, signed), eq(protocolForwards.status, "sent")));
      log(`forward of ${sol(total)} failed: ${error}`);
    }
  });
}
