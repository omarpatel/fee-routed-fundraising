import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { causes, deliveries, vaults, type Cause, type Delivery, type Rail as RailId } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { loadKeypair } from "@/lib/keys";
import { claimDelivery, fundingFailed, LedgerError, markFunded, markFunding } from "@/lib/ledger";
import { withLock } from "@/lib/ledger/locks";
import { sendOutcome, transferUsdc } from "@/lib/solana/transfer";
import { ZENTRO_MIN_DEPOSIT_USD } from "@/lib/zentro/client";
import { getZentroClient, ZentroNotConfiguredError } from "@/lib/zentro/session-store";

export type FinalizeRequirement = "railRef" | "amountFiat" | "artifacts";
/** Rails with a live implementation. The schema enum reserves the others for later. */
export type LiveRailId = Extract<RailId, "operator_card" | "onchain">;

export interface Rail {
  id: LiveRailId;
  label: string;
  /** Human sentence for receipts: how the money physically moved. */
  description: string;
  /**
   * Move USDC from the vault treasury onto the rail and advance the delivery (`funded` when the
   * money is already on the rail, `funding` when the rail still has to credit it). The row is
   * claimed `queued` → `funding` before anything is sent, so a second caller gets a 409 instead of
   * a second transfer. Throws `RailNotConfiguredError` when the rail is not configured; errors
   * before the transfer release the claim (delivery back to `queued`); a transfer error fails the
   * delivery, or keeps it `funding` with the signature when USDC may already have moved.
   */
  fund(delivery: Delivery): Promise<Delivery>;
  /** What `finalizeDelivery` insists on. Card deliveries the reconciler matched carry their own evidence. */
  finalizeRequirements(delivery: Delivery): FinalizeRequirement[];
  /** Whether the worker may fund + finalize without an operator. */
  automatic: boolean;
}

export class RailNotConfiguredError extends Error {
  constructor(rail: RailId, what: string) {
    super(`Rail ${rail} not configured: ${what}`);
    this.name = "RailNotConfiguredError";
  }
}

/** Zentro may quote slightly more than the top-up (bridge fee); anything beyond this is refused. */
const BRIDGE_FEE_MAX = 1.05;

async function treasuryKeypair(rail: LiveRailId, vaultId: string) {
  if (!configured.kms) throw new RailNotConfiguredError(rail, "FEE_ROUTER_KMS_KEY");
  if (!configured.rpc) throw new RailNotConfiguredError(rail, "SOLANA_RPC_URL");
  const v = await db.select({ treasuryAddress: vaults.treasuryAddress }).from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!v) throw new Error("Vault not found");
  return loadKeypair(v.treasuryAddress);
}

/** Zentro invoice fields. A new funding attempt clears the previous (refused) attempt's invoice. */
const NO_BRIDGE = { bridgeId: null, bridgeDepositAddress: null, bridgeAmountUsdc: null, bridgeExpiresAt: null, bridgeStatus: null };

/**
 * The transfer landed: if writing that down fails, the error carries the signature so
 * `fundingFailed` keeps the row `funding` instead of failing it, which would release the amount
 * and pay the cause a second time.
 */
async function recordSent(signature: string, write: () => Promise<Delivery>): Promise<Delivery> {
  try {
    return await write();
  } catch (e) {
    throw Object.assign(new Error(`Funding transfer ${signature} was sent but recording it failed: ${e instanceof Error ? e.message : String(e)}`), { signature });
  }
}

/**
 * `transferUsdc`'s `onSigned`: the signature and its expiry land on the (still `funding`) row before
 * the broadcast, so a crash or lost confirmation leaves a row `settleUnconfirmedFunding` can settle.
 * `extra` carries rail fields the settlement needs (the Zentro invoice).
 */
function recordSigned(deliveryId: string, extra: Partial<typeof deliveries.$inferInsert> = {}) {
  return async (fundingTxSig: string, fundingLastValidBlockHeight: number) => {
    const r = await db
      .update(deliveries)
      .set({ ...extra, fundingTxSig, fundingLastValidBlockHeight })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "funding")));
    if (r.rowsAffected !== 1) throw new Error(`Delivery ${deliveryId} is no longer funding; transfer not broadcast`);
  };
}

/**
 * Claim the row, run `prepare` (no money moves; failure releases the claim), then `send` (money
 * moves; failure is recorded on the row by `fundingFailed`). Serialised per delivery in-process.
 */
async function claimAndSend<P>(delivery: Delivery, prepare: () => Promise<P>, send: (prepared: P) => Promise<Delivery>): Promise<Delivery> {
  return withLock(`delivery:${delivery.id}`, async () => {
    // A stale invoice left on the row would have the bridge poller judge (and fail) this attempt mid-transfer.
    if (!(await claimDelivery(delivery.id, "queued", "funding", NO_BRIDGE))) {
      const cur = await db.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.id, delivery.id)).get();
      throw new LedgerError(`Delivery is ${cur?.status ?? "missing"}, expected queued`, 409);
    }
    let prepared: P;
    try {
      prepared = await prepare();
    } catch (e) {
      await claimDelivery(delivery.id, "funding", "queued");
      throw e;
    }
    try {
      return await send(prepared);
    } catch (e) {
      await fundingFailed(delivery.id, e);
      throw e;
    }
  });
}

/**
 * Operator-held crypto card (Zentro). Treasury USDC tops up the card through a one-time invoice
 * (`funding` until Zentro credits it), the operator donates on the fundraiser's own platform, and
 * the reconciler matches the card purchase. Zentro has no API; the tap is never automated.
 */
export const operatorCard: Rail = {
  id: "operator_card",
  label: "Operator card",
  description: "USDC tops up a Fee Router-operated card; the operator donates on the fundraiser's platform and the card statement is reconciled.",
  finalizeRequirements: (d) => (d.cardTxId ? [] : ["artifacts", "railRef", "amountFiat"]),
  automatic: false,
  async fund(delivery) {
    if (delivery.amountUsdc < ZENTRO_MIN_DEPOSIT_USD) throw new LedgerError(`Zentro minimum top-up is $${ZENTRO_MIN_DEPOSIT_USD}`);
    return claimAndSend(
      delivery,
      async () => {
        const kp = await treasuryKeypair("operator_card", delivery.vaultId);
        let client;
        try {
          client = await getZentroClient();
        } catch (e) {
          if (e instanceof ZentroNotConfiguredError) throw new RailNotConfiguredError("operator_card", e.message);
          throw e;
        }
        const invoice = await client.createDeposit(delivery.amountUsdc, "SOL-USDC");
        const bridge = {
          bridgeId: invoice.bridge_id,
          bridgeDepositAddress: invoice.deposit_address,
          bridgeAmountUsdc: Number(invoice.amount_to_send),
          bridgeExpiresAt: new Date(Date.now() + invoice.expires_in_seconds * 1000),
        };
        // The invoice is Zentro's word, not ours: never send more than the delivery plus a small bridge fee.
        if (!(Number.isFinite(bridge.bridgeAmountUsdc) && bridge.bridgeAmountUsdc >= delivery.amountUsdc && bridge.bridgeAmountUsdc <= delivery.amountUsdc * BRIDGE_FEE_MAX)) {
          await db.update(deliveries).set({ ...bridge, bridgeAmountUsdc: Number.isFinite(bridge.bridgeAmountUsdc) ? bridge.bridgeAmountUsdc : null, bridgeStatus: "refused" }).where(eq(deliveries.id, delivery.id));
          throw new LedgerError(`Zentro invoice amount out of bounds: asked to send ${invoice.amount_to_send} USDC for a $${delivery.amountUsdc.toFixed(2)} delivery`, 409);
        }
        return { kp, bridge };
      },
      async ({ kp, bridge }) => {
        const fee = Math.round((bridge.bridgeAmountUsdc - delivery.amountUsdc) * 100) / 100;
        const notes = fee > 0 ? `Zentro bridge fee: ${fee.toFixed(2)} USDC (sent ${bridge.bridgeAmountUsdc.toFixed(2)} for a ${delivery.amountUsdc.toFixed(2)} top-up).` : null;
        let fundingTxSig: string;
        try {
          fundingTxSig = await transferUsdc(kp, bridge.bridgeDepositAddress, bridge.bridgeAmountUsdc, recordSigned(delivery.id, { ...bridge, bridgeStatus: "sending" }));
        } catch (e) {
          // Invoice exists: keep it on the row so the failure is diagnosable.
          await db.update(deliveries).set({ ...bridge, bridgeStatus: "unfunded" }).where(eq(deliveries.id, delivery.id));
          throw e;
        }
        return recordSent(fundingTxSig, () => markFunding(delivery.id, { ...bridge, fundingTxSig, notes }));
      },
    );
  },
};

/** Direct USDC transfer to the cause's own address. Funding is the delivery. */
export const onchain: Rail = {
  id: "onchain",
  label: "On-chain USDC",
  description: "USDC transferred directly from the vault treasury to the cause's wallet.",
  finalizeRequirements: () => [],
  automatic: true,
  async fund(delivery) {
    return claimAndSend(
      delivery,
      async () => {
        const cause = await db.select({ onchainAddress: causes.onchainAddress }).from(causes).where(eq(causes.id, delivery.causeId)).get();
        if (!cause?.onchainAddress) throw new Error("Cause has no on-chain address");
        return { kp: await treasuryKeypair("onchain", delivery.vaultId), to: cause.onchainAddress };
      },
      async ({ kp, to }) => {
        const sig = await transferUsdc(kp, to, delivery.amountUsdc, recordSigned(delivery.id));
        return recordSent(sig, () => markFunded(delivery.id, sig));
      },
    );
  },
};

export const RAILS_BY_ID: Record<Rail["id"], Rail> = { operator_card: operatorCard, onchain };

export function railForCause(cause: Pick<Cause, "platform" | "onchainAddress">): Rail {
  return cause.platform === "onchain" && cause.onchainAddress ? onchain : operatorCard;
}

export function railById(id: RailId): Rail {
  if (id !== "operator_card" && id !== "onchain") throw new Error(`Rail ${id} is not implemented`);
  return RAILS_BY_ID[id];
}

export interface FundingSettlement {
  outcome: "landed" | "failed" | "waiting";
  detail: string;
}

/**
 * `funding` rows whose transfer was signed but never confirmed: the RPC dropped the send or the
 * confirmation, the process died mid-send, or recording the landed transfer failed. Legacy onchain
 * rows (sent before the expiry was recorded) carry only the signature.
 */
export async function unconfirmedFunding(): Promise<Delivery[]> {
  return db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.status, "funding"), isNotNull(deliveries.fundingTxSig), or(isNotNull(deliveries.fundingLastValidBlockHeight), eq(deliveries.rail, "onchain"))));
}

/**
 * Settle an unconfirmed funding transfer from the chain, under the same lock as `fund`. Landed →
 * the rail's success path (onchain: `funded`; card: invoice `waiting` for Zentro). Failed on-chain,
 * or expired without a trace → `failed` with the signature dropped from `fundingTxSig` (nothing left
 * the treasury, so nothing is stranded). Otherwise, including a legacy row whose signature is not
 * found, it waits. Idempotent: a row that is no longer unconfirmed is left alone.
 */
export async function settleUnconfirmedFunding(deliveryId: string): Promise<FundingSettlement> {
  return withLock(`delivery:${deliveryId}`, async () => {
    const d = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).get();
    const sig = d?.fundingTxSig;
    if (!d || d.status !== "funding" || !sig || (d.fundingLastValidBlockHeight === null && d.rail !== "onchain")) return { outcome: "waiting", detail: `not an unconfirmed funding transfer (${d?.status ?? "missing"})` };
    const lvbh = d.fundingLastValidBlockHeight;
    const out = await sendOutcome(sig, lvbh);
    if (out.state === "landed") {
      const notes = `Funding transfer ${sig} confirmed on-chain after its send was interrupted.`;
      if (d.rail === "onchain") {
        await markFunded(d.id, sig);
        await db.update(deliveries).set({ notes }).where(eq(deliveries.id, d.id));
        return { outcome: "landed", detail: `${sig} landed; funded` };
      }
      if (!d.bridgeId || !d.bridgeDepositAddress || d.bridgeAmountUsdc === null || !d.bridgeExpiresAt) return { outcome: "waiting", detail: `${sig} landed but the Zentro invoice is not on the row; operator must attach it` };
      await markFunding(d.id, { bridgeId: d.bridgeId, bridgeDepositAddress: d.bridgeDepositAddress, bridgeAmountUsdc: d.bridgeAmountUsdc, bridgeExpiresAt: d.bridgeExpiresAt, fundingTxSig: sig, notes });
      return { outcome: "landed", detail: `${sig} landed; waiting for Zentro to credit the card` };
    }
    if (out.state === "unknown") return { outcome: "waiting", detail: lvbh === null ? `${sig} not found on-chain and its expiry was never recorded; operator must resolve` : `${sig} not settled yet (valid until block ${lvbh})` };
    const reason =
      out.state === "failed"
        ? `Funding transfer ${sig} failed on-chain (${JSON.stringify(out.err)}); no USDC left the treasury.`
        : `Funding transfer ${sig} expired unconfirmed: the chain passed block ${lvbh} without it, so it never landed and no USDC left the treasury.`;
    await claimDelivery(d.id, "funding", "failed", { failureReason: reason, fundingTxSig: null, fundingLastValidBlockHeight: null, ...(d.rail === "operator_card" ? { bridgeStatus: "unfunded" } : {}) });
    return { outcome: "failed", detail: reason };
  });
}
