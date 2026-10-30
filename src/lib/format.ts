import type { Delivery } from "@/lib/db/schema";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US");

/** $1,234 — whole dollars, for headlines and cards. */
export function usd(n: number): string {
  return usd0.format(n);
}
/** $1,234.56 — cents, for ledger rows and receipts. */
export function usdCents(n: number): string {
  return usd2.format(n);
}
export function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  return usd0.format(n);
}
export function count(n: number): string {
  return num.format(n);
}
/** Ab3d…9xYz — for addresses, signatures, hashes. */
export function short(s: string, head = 4, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
export function dateShort(d: Date | number | string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function dateTime(d: Date | number | string): string {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
export function timeAgo(d: Date | number | string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** Receipt number: RCP-0007 */
export function receiptNo(ordinal: number): string {
  return `RCP-${String(ordinal).padStart(4, "0")}`;
}
export function rawToUi(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}
export function bps(n: number): string {
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}
export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}
export function solscanAddr(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}
/**
 * Why a failed or reversed delivery did not land, as the public receipt states it; null for any
 * other status. Derived from state alone: `failureReason` is raw upstream error text and stays on
 * the operator desk.
 */
export function publicFailureReason(d: Pick<Delivery, "status" | "fundingTxSig" | "fundingRecoveredAt">): string | null {
  if (d.status === "reversed") return "Reversed after delivery.";
  if (d.status !== "failed") return null;
  if (!d.fundingTxSig) return "Funding failed before any money left the treasury.";
  return d.fundingRecoveredAt ? "The funding transfer left the treasury and was later returned to it." : "The funding transfer left the treasury but the delivery did not complete. The amount stays reserved until the operator resolves it.";
}
