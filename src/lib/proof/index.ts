import { createHash } from "node:crypto";
import type { Delivery } from "@/lib/db/schema";
import type { ReceiptDetail } from "@/lib/db/queries";

export { verifyAnchorOnChain, type AnchorCheck } from "./onchain";

export const MEMO_PREFIX = "fee-router:v1:";

/**
 * Canonical receipt: the exact bytes that get hashed and anchored. Stable key order at every
 * level, no whitespace, nulls preserved, dates as ISO strings. Delivery status is deliberately
 * excluded: the hash is computed at finalize time with deliveredAt fixed, and must remain
 * recomputable from the public receipt forever.
 */
export interface CanonicalReceipt {
  v: 1;
  id: string;
  ordinal: number;
  vault: { id: string; slug: string; name: string; treasuryAddress: string };
  cause: { id: string; slug: string; title: string; platform: string; url: string };
  amountUsdc: number;
  amountFiat: number | null;
  fiatCurrency: string | null;
  fxRate: number | null;
  platformFeeFiat: number | null;
  rail: Delivery["rail"];
  railRef: string | null;
  fundingTxSig: string | null;
  allocations: { tokenId: string; symbol: string; amountUsdc: number }[];
  artifacts: { kind: string; label: string; sha256: string; bytes: number }[];
  period: { label: string; startsAt: string; endsAt: string } | null;
  deliveredAt: string | null;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const src = value as Record<string, unknown>; // plain object: keys are strings by construction
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return value;
}

export function toCanonicalObject(r: ReceiptDetail): CanonicalReceipt {
  const d = r.delivery;
  return {
    v: 1,
    id: d.id,
    ordinal: d.ordinal,
    vault: { id: r.vault.id, slug: r.vault.slug, name: r.vault.name, treasuryAddress: r.vault.treasuryAddress },
    cause: { id: r.cause.id, slug: r.cause.slug, title: r.cause.title, platform: r.cause.platform, url: r.cause.url },
    amountUsdc: d.amountUsdc,
    amountFiat: d.amountFiat,
    fiatCurrency: d.fiatCurrency,
    fxRate: d.fxRate,
    platformFeeFiat: d.platformFeeFiat,
    rail: d.rail,
    railRef: d.railRef,
    fundingTxSig: d.fundingTxSig,
    allocations: r.allocations
      .map((a) => ({ tokenId: a.tokenId, symbol: a.token.symbol, amountUsdc: a.amountUsdc }))
      .sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0)),
    artifacts: r.artifacts
      .map((a) => ({ kind: a.kind, label: a.label, sha256: a.sha256, bytes: a.bytes }))
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)),
    period: r.period ? { label: r.period.label, startsAt: new Date(r.period.startsAt).toISOString(), endsAt: new Date(r.period.endsAt).toISOString() } : null,
    deliveredAt: d.deliveredAt ? new Date(d.deliveredAt).toISOString() : null,
  };
}

export function canonicalReceipt(r: ReceiptDetail): string {
  return JSON.stringify(sortKeysDeep(toCanonicalObject(r)));
}

export function receiptHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function memoFor(deliveryId: string, hash: string): string {
  return `${MEMO_PREFIX}${deliveryId}:${hash}`;
}

/** Parse `fee-router:v1:<id>:<hash>`; null when the memo is not ours. */
export function parseMemo(memo: string): { id: string; hash: string } | null {
  if (!memo.startsWith(MEMO_PREFIX)) return null;
  const rest = memo.slice(MEMO_PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i <= 0) return null;
  const hash = rest.slice(i + 1);
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return { id: rest.slice(0, i), hash };
}

export interface VerifyResult {
  ok: boolean;
  computedHash: string;
  anchoredHash: string | null;
  anchorTxSig: string | null;
}

/** Pure, synchronous: recompute from the public receipt and compare with the stored hash. */
export function verifyReceipt(r: ReceiptDetail): VerifyResult {
  const computedHash = receiptHash(canonicalReceipt(r));
  const anchoredHash = r.delivery.receiptHash;
  return { ok: anchoredHash !== null && anchoredHash === computedHash, computedHash, anchoredHash, anchorTxSig: r.delivery.anchorTxSig };
}
