/**
 * Fee Router worker steps. Runs embedded in the Next.js server (see `src/instrumentation.ts`) so the
 * single SQLite volume has one writer, and standalone via `pnpm worker` for local runs.
 *
 * Every tick:
 *   ingestRetry     webhook transactions whose ingest threw (price feed / RPC down) → booked as `fee_events`
 *   sweep           route address balances → USDC in the vault treasury (Jupiter), recorded as `sweeps`
 *   settleSends     funding transfers / withdrawals sent but never confirmed → landed, failed or expired, read from the chain
 *   launchRecovery  pump.fun launches that stopped partway → token registered if its mint exists, else SOL refunded once
 *   autoQueue       vaults whose deliverable ≥ threshold and nothing in flight → queueDelivery
 *   closePeriods    freeze finished weekly periods, open the current one
 *   autoDeliver     `onchain` rail: fund + finalize without an operator
 *   protocolFees    $ROUTE creator fees accrued to the protocol treasury (the token's creator) → claimed
 *   protocolForward treasury creator fee claims → `protocol_forwards`; the Commons share → sent to the Commons route
 *   anchorRetry     delivered receipts whose memo could not be anchored at seal time
 *   zentroBridges   `operator_card` top-ups: poll the Zentro invoice; credited → funded + operator emailed
 *   zentroReconcile `operator_card` funded: match the card purchase, attach statement + confirmation, seal
 * Every step reports exactly why it did nothing when a key or RPC is missing.
 */
import { PublicKey } from "@solana/web3.js";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { deliveries, feeEvents, sweeps, tokens, vaults } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { loadKeypair } from "@/lib/keys";
import { closePeriods, deliverable, finalizeDelivery, queueDelivery, retryAnchors } from "@/lib/ledger";
import { retryFailedIngests } from "@/lib/ledger/ingest";
import { railById, settleUnconfirmedFunding, unconfirmedFunding } from "@/lib/rails";
import { swapToUsdc } from "@/lib/solana/jupiter";
import { SOL_MINT, USDC_MINT, rpc } from "@/lib/solana/rpc";
import { transferUsdc } from "@/lib/solana/transfer";
import { claimCreatorFees } from "@/lib/launchpads/pumpfun";
import { launchRecoveryStep } from "@/lib/launchpads/recovery";
import { getProtocolConfig } from "@/lib/protocol/config";
import { forwardCommonsShare, recordProtocolClaims } from "@/lib/protocol/forward";
import { settleSentWithdrawals } from "@/lib/wallet";
import { zentroBridgesStep, zentroReconcileStep } from "@/lib/zentro/reconcile";

const INTERVAL_MS = 60_000;
/** Below this the swap fee eats the sweep. */
const DUST_SOL = 0.01;
const DUST_USDC = 1;
const SLIPPAGE_BPS = 100;

const log = (step: string, msg: string) => console.log(`${new Date().toISOString()} [${step}] ${msg}`);

async function sweep() {
  if (!configured.kms) return log("sweep", "skipped: FEE_ROUTER_KMS_KEY not configured");
  if (!configured.rpc) return log("sweep", "skipped: SOLANA_RPC_URL not configured");
  if (!configured.jupiter) return log("sweep", "skipped: JUPITER_API_KEY not configured");
  const rows = await db.select({ token: tokens, treasury: vaults.treasuryAddress }).from(tokens).innerJoin(vaults, eq(vaults.id, tokens.vaultId)).where(eq(vaults.status, "active"));
  const conn = rpc();
  for (const { token, treasury } of rows) {
    let kp;
    try {
      kp = await loadKeypair(token.routeAddress);
    } catch {
      log("sweep", `${token.symbol}: no custodial key for route ${token.routeAddress} (seeded/synthetic); skipped`);
      continue;
    }
    // pump.fun creator fees sit in the creator vault until claimed; the route key is the creator.
    if (token.source === "pumpfun") {
      try {
        const c = await claimCreatorFees(kp);
        if (c.signature) log("sweep", `${token.symbol}: claimed creator fees (${c.signature})`);
      } catch (e) {
        log("sweep", `${token.symbol}: creator fee claim failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // SOL (keep a fee reserve) is swapped on the route; then all USDC on the route (swap output included,
    // at its actual fill, not Jupiter's quote) moves to the treasury. Other SPL fees are rare on these launchpads.
    const lamports = await conn.getBalance(kp.publicKey, "confirmed");
    const sol = lamports / 1e9;
    if (sol > DUST_SOL) {
      const amountRaw = BigInt(lamports) - BigInt(Math.round(0.005 * 1e9));
      try {
        const r = await swapToUsdc(kp, SOL_MINT, amountRaw, SLIPPAGE_BPS, 9);
        const sweepId = `swp_${nanoid(12)}`;
        await db.insert(sweeps).values({ id: sweepId, vaultId: token.vaultId, tokenId: token.id, txSig: r.sig, inputMint: SOL_MINT, inputAmountRaw: amountRaw.toString(), outputUsdcRaw: r.outAmountRaw, rate: r.rate, slippageBps: SLIPPAGE_BPS, createdAt: new Date() });
        await db.update(feeEvents).set({ sweepId }).where(and(eq(feeEvents.tokenId, token.id), eq(feeEvents.assetMint, SOL_MINT), isNull(feeEvents.sweepId)));
        log("sweep", `${token.symbol}: ${sol.toFixed(4)} SOL → ~${(Number(BigInt(r.outAmountRaw)) / 1e6).toFixed(2)} USDC (swap ${r.sig})`);
      } catch (e) {
        log("sweep", `${token.symbol}: swap failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    const usdcMint = USDC_MINT.toBase58();
    const usdcAccts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(usdcMint) });
    const usdcHeld = usdcAccts.value.reduce((a, x) => a + (x.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
    if (usdcHeld > DUST_USDC) {
      try {
        const sig = await transferUsdc(kp, treasury, usdcHeld);
        const sweepId = `swp_${nanoid(12)}`;
        const raw = BigInt(Math.round(usdcHeld * 1e6)).toString();
        await db.insert(sweeps).values({ id: sweepId, vaultId: token.vaultId, tokenId: token.id, txSig: sig, inputMint: usdcMint, inputAmountRaw: raw, outputUsdcRaw: raw, rate: 1, slippageBps: 0, createdAt: new Date() });
        await db.update(feeEvents).set({ sweepId }).where(and(eq(feeEvents.tokenId, token.id), eq(feeEvents.assetMint, usdcMint), isNull(feeEvents.sweepId)));
        log("sweep", `${token.symbol}: ${usdcHeld.toFixed(2)} USDC → treasury (${sig})`);
      } catch (e) {
        log("sweep", `${token.symbol}: USDC move failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/**
 * Settle transfers whose confirmation was never observed, before autoQueue: a funding transfer that
 * expired unseen fails its delivery and frees the vault's queue this tick; one that landed advances
 * and autoDeliver seals it this tick.
 */
async function settleSends() {
  if (!configured.rpc) return log("settleSends", "skipped: needs SOLANA_RPC_URL");
  const funding = await unconfirmedFunding();
  for (const d of funding) {
    try {
      const r = await settleUnconfirmedFunding(d.id);
      log("settleSends", `${d.id}: ${r.outcome} · ${r.detail}`);
    } catch (e) {
      log("settleSends", `${d.id}: settle failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const withdrawals = await settleSentWithdrawals();
  for (const w of withdrawals) log("settleSends", `withdrawal ${w.id}: ${w.outcome}`);
  if (funding.length + withdrawals.length === 0) log("settleSends", "no unconfirmed transfers");
}

async function autoQueue() {
  const active = await db.select().from(vaults).where(eq(vaults.status, "active"));
  // One vault's refusal (unverified cause, treasury lookup down) must not stop the vaults after it.
  for (const v of active) {
    try {
      const d = await deliverable(v.id);
      if (d.inFlight > 0) {
        log("autoQueue", `${v.slug}: ${d.inFlight} delivery in flight; waiting`);
        continue;
      }
      if (d.totalUsd < v.deliveryThresholdUsd) {
        log("autoQueue", `${v.slug}: deliverable $${d.totalUsd.toFixed(2)} < threshold $${v.deliveryThresholdUsd}`);
        continue;
      }
      const q = await queueDelivery(v.id, d.totalUsd);
      log("autoQueue", `${v.slug}: queued ${q.id} #${q.ordinal} $${q.amountUsdc.toFixed(2)} via ${q.rail}`);
    } catch (e) {
      log("autoQueue", `${v.slug}: not queued: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function periodsStep() {
  const all = await db.select({ id: vaults.id, slug: vaults.slug }).from(vaults);
  for (const v of all) {
    const r = await closePeriods(v.id);
    if (r.closed > 0) log("closePeriods", `${v.slug}: closed ${r.closed}, open ${r.open.label}`);
  }
  log("closePeriods", `${all.length} vault(s) checked`);
}

/**
 * Fund and seal `onchain` deliveries. Every decision is made on a fresh read of the row, never the
 * loop snapshot: a delivery that already carries a funding signature is never funded again, and a
 * row past `queued` is never failed here — only settleSends, reading the chain, decides whether an
 * unconfirmed transfer landed.
 */
async function autoDeliver() {
  // `executing` here is a seal that was interrupted (crash between hash and flip); finalize resumes it once its lease lapses.
  const pending = await db.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.rail, "onchain"), inArray(deliveries.status, ["queued", "funding", "funded", "executing"])));
  if (pending.length === 0) return log("autoDeliver", "no onchain deliveries pending");
  if (!configured.kms || !configured.rpc) return log("autoDeliver", `${pending.length} onchain delivery(ies) pending; skipped: needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL`);
  const rail = railById("onchain");
  for (const { id } of pending) {
    const cur = await db.select().from(deliveries).where(eq(deliveries.id, id)).get();
    if (!cur) continue;
    if (cur.status === "funding") {
      log("autoDeliver", `${id}: funding transfer ${cur.fundingTxSig ?? "(none)"} unconfirmed; settleSends resolves it from the chain — not retried`);
      continue;
    }
    if (cur.status === "queued" && cur.fundingTxSig) {
      log("autoDeliver", `${id}: queued but already carries funding tx ${cur.fundingTxSig}; refusing to fund again`);
      continue;
    }
    if (cur.status === "queued") {
      try {
        const funded = await rail.fund(cur);
        log("autoDeliver", `${id}: funded ${funded.fundingTxSig}`);
      } catch (e) {
        // rail.fund already recorded the outcome on the row (failed, or funding + signature).
        log("autoDeliver", `${id}: funding failed: ${e instanceof Error ? e.message : e}`);
        continue;
      }
    }
    const now = await db.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.id, id)).get();
    if (now?.status !== "funded" && now?.status !== "executing") {
      log("autoDeliver", `${id}: is ${now?.status ?? "missing"} after funding; not sealing`);
      continue;
    }
    try {
      const done = await finalizeDelivery(id, { executedByUserId: null });
      log("autoDeliver", `${id}: delivered, receipt ${done.receiptHash?.slice(0, 12)}… anchor ${done.anchorTxSig ?? "(pending: anchorRetry)"}`);
    } catch (e) {
      log("autoDeliver", `${id}: seal failed, stays ${now.status} for the next tick: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function anchorRetry() {
  const unanchored = await db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(eq(deliveries.status, "delivered"), isNull(deliveries.anchorTxSig), isNotNull(deliveries.receiptHash))).get();
  if (!unanchored?.n) return log("anchorRetry", "every delivered receipt is anchored");
  if (!configured.anchor) return log("anchorRetry", `${unanchored.n} receipt(s) unanchored; skipped: needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL`);
  const r = await retryAnchors(20);
  for (const err of r.errors) log("anchorRetry", `failed: ${err}`);
  log("anchorRetry", `anchored ${r.anchored.length}, ${r.pending} still pending${r.errors.length ? " (anchor signer needs SOL? see /admin)" : ""}`);
}

async function ingestRetry() {
  const r = await retryFailedIngests(50);
  if (r.length === 0) return log("ingestRetry", "no failed webhook ingests");
  const failing = r.filter((x) => x.error);
  log("ingestRetry", `re-ran ${r.length} failed ingest(s): ${r.length - failing.length} booked, ${failing.length} still failing${failing.length ? ` (first: ${failing[0].signature}: ${failing[0].error})` : ""}`);
}

let stopping = false;
/** Resolves the inter-tick sleep early so SIGINT exits without waiting out the interval. */
let wake: (() => void) | null = null;

/** $ROUTE creator fees accrue to the protocol treasury (the token's creator) when $ROUTE was launched here; claim them each tick. */
async function claimProtocolFees() {
  if (!configured.kms || !configured.rpc) return log("protocolFees", "skipped: needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL");
  const [mint, treasury, launchId] = await Promise.all([getProtocolConfig("protocol_mint"), getProtocolConfig("protocol_treasury_address"), getProtocolConfig("protocol_launch_id")]);
  if (!mint || !treasury) return log("protocolFees", "skipped: $ROUTE not launched");
  // A $ROUTE launched outside Fee Router has its own creator wallet; its fees are handled manually.
  if (!launchId) return log("protocolFees", "skipped: $ROUTE was launched outside Fee Router; creator fees are handled manually");
  const kp = await loadKeypair(treasury);
  const c = await claimCreatorFees(kp);
  log("protocolFees", c.signature ? `claimed (${c.signature})` : `nothing to claim`);
}

/**
 * Book every treasury creator fee claim (this worker's or anyone's) and forward the Commons share
 * owed on them to the Commons route, where ingest books it as a Commons fee event.
 */
async function protocolForward() {
  const recorded = await recordProtocolClaims();
  if (recorded > 0) log("protocolForward", `booked ${recorded} creator fee claim(s)`);
  await forwardCommonsShare((m) => log("protocolForward", m));
}

async function tick() {
  const t0 = Date.now();
  for (const [name, fn] of [
    ["ingestRetry", ingestRetry],
    ["sweep", sweep],
    ["settleSends", settleSends],
    ["launchRecovery", () => launchRecoveryStep((m) => log("launchRecovery", m))],
    ["autoQueue", autoQueue],
    ["closePeriods", periodsStep],
    ["autoDeliver", autoDeliver],
    ["protocolFees", claimProtocolFees],
    ["protocolForward", protocolForward],
    ["anchorRetry", anchorRetry],
    ["zentroBridges", () => zentroBridgesStep((m) => log("zentroBridges", m))],
    ["zentroReconcile", () => zentroReconcileStep((m) => log("zentroReconcile", m))],
  ] as const) {
    if (stopping) return;
    try {
      await fn();
    } catch (e) {
      log(name, `error: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }
  log("tick", `done in ${Date.now() - t0}ms`);
}


let loop: { stop: () => void } | null = null;

/** Start the periodic loop once per process. Returns a handle; second call is a no-op. */
export function startWorkerLoop(intervalMs = INTERVAL_MS): { stop: () => void } {
  if (loop) return loop;
  log("worker", `starting; kms=${configured.kms} rpc=${configured.rpc} jupiter=${configured.jupiter} helius=${configured.helius} anchor=${configured.anchor} zentroLogin=${configured.zentroLogin}`);
  stopping = false;
  const run = async () => {
    while (!stopping) {
      await tick();
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
    log("worker", "stopped");
  };
  const done = run();
  loop = {
    stop: () => {
      if (stopping) return;
      stopping = true;
      log("worker", "stopping");
      wake?.();
      void done;
    },
  };
  return loop;
}

export { tick };
