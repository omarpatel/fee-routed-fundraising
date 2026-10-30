import type { Delivery } from "@/lib/db/schema";
import { readMemos } from "@/lib/solana/memo";
import { memoFor, parseMemo } from "./index";

export interface AnchorCheck {
  /** A memo matching `fee-router:v1:<id>:<receiptHash>` exists in `anchorTxSig`. */
  found: boolean;
  /** The first fee-router memo present in the tx (may mismatch), or null. */
  memo: string | null;
  /** Null when the delivery has no anchor tx to check. */
  anchorTxSig: string | null;
}

/** Async counterpart to verifyReceipt: fetch the anchor tx and compare its memo. Never throws on RPC failure. */
export async function verifyAnchorOnChain(delivery: Pick<Delivery, "id" | "receiptHash" | "anchorTxSig">): Promise<AnchorCheck> {
  if (!delivery.anchorTxSig || !delivery.receiptHash) return { found: false, memo: null, anchorTxSig: delivery.anchorTxSig };
  let memos: string[];
  try {
    memos = await readMemos(delivery.anchorTxSig);
  } catch (e) {
    console.warn(`[anchor] RPC lookup failed for ${delivery.anchorTxSig}: ${e instanceof Error ? e.message : e}`);
    return { found: false, memo: null, anchorTxSig: delivery.anchorTxSig };
  }
  const expected = memoFor(delivery.id, delivery.receiptHash);
  const ours = memos.find((m) => parseMemo(m)?.id === delivery.id) ?? null;
  return { found: memos.includes(expected), memo: ours, anchorTxSig: delivery.anchorTxSig };
}
