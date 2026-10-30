import Link from "next/link";
import type { ReactNode } from "react";
import { cx, Eyebrow, Pill, StatusPill, TokenMark } from "@/components/ui";
import { short, solscanTx, usdCents } from "@/lib/format";
import type { CausePlatform, Rail, TokenSource } from "@/lib/db/schema";
import type { DeliveryWithAllocations } from "@/lib/db/queries";

export { ZentroPanel } from "./ZentroPanel";

/* ------------------------------------------------------------------
   App-level building blocks shared by explore / vault / cause / receipt /
   dashboard / ops. Server-safe; nothing here holds state.
   ------------------------------------------------------------------ */

export const PLATFORM_LABEL: Record<CausePlatform, string> = {
  gofundme: "GoFundMe",
  launchgood: "LaunchGood",
  justgiving: "JustGiving",
  gogetfunding: "GoGetFunding",
  everyorg: "Every.org",
  stripe_link: "Stripe link",
  onchain: "On-chain USDC",
  other: "Other",
};

export const SOURCE_LABEL: Record<TokenSource, string> = { pumpfun: "pump.fun", bags: "Bags", meteora: "Meteora", manual: "Manual" };

export const RAIL_LABEL: Record<Rail, string> = {
  operator_card: "Operator card",
  onchain: "On-chain USDC",
  stripe_link: "Stripe link",
  gofundme_pro: "GoFundMe Pro",
  issuing_card: "Issued card",
};

export const CATEGORY_LABEL: Record<string, string> = { medical: "Medical", water: "Water", education: "Education", relief: "Relief", other: "Other" };

export function PlatformPill({ platform }: { platform: CausePlatform }) {
  return <Pill tone={platform === "onchain" ? "usdc" : "muted"}>{PLATFORM_LABEL[platform]}</Pill>;
}

export function SourcePill({ source }: { source: TokenSource }) {
  return <Pill tone="muted">{SOURCE_LABEL[source]}</Pill>;
}

export function RailPill({ rail }: { rail: Rail }) {
  return <Pill tone={rail === "onchain" ? "usdc" : "ink"}>{RAIL_LABEL[rail]}</Pill>;
}

/** Route lock: on-chain proof link when locked, a stamp-toned warning when not. */
export function RouteLockPill({ locked, proofTx }: { locked: boolean; proofTx: string | null }) {
  if (locked && proofTx) {
    return (
      <a href={solscanTx(proofTx)} target="_blank" rel="noreferrer" className="hit inline-flex focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp rounded-full">
        <Pill tone="verify">
          <CheckGlyph /> locked · {short(proofTx)}
        </Pill>
      </a>
    );
  }
  if (locked) return <Pill tone="verify">locked</Pill>;
  return <Pill tone="stamp">unlocked</Pill>;
}

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden className={className}>
      <path d="M2 6.5l2.6 2.6L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Hairline progress bar. `value` in [0,1]; overflows clamp. */
export function ProgressBar({ value, tone = "ink", className }: { value: number; tone?: "ink" | "verify" | "usdc"; className?: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  const fill = tone === "verify" ? "bg-verify" : tone === "usdc" ? "bg-usdc" : "bg-ink";
  return (
    <div className={cx("h-[3px] w-full bg-paper-3 overflow-hidden", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className={cx("h-full", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Perforated receipt paper. `receipt-edge` masks to the content box, so the outer element carries
 * only the 6px vertical padding for the edge pattern; the inner element carries the real padding.
 */
export function ReceiptPaper({ children, className, inner, as: As = "div" }: { children: ReactNode; className?: string; inner?: string; as?: "div" | "article" | "section" }) {
  return (
    <As className={cx("receipt-edge bg-[#faf8f2] py-1.5", className)}>
      <div className={cx("px-5 py-3", inner)}>{children}</div>
    </As>
  );
}

/** Big mono figure with an eyebrow. */
export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx("py-4", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2 font-mono text-[28px] sm:text-[34px] leading-none tabular-nums tracking-tight">{value}</div>
      {sub ? <div className="mt-2 text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}

export function SectionHead({ title, aside, id, className }: { title: ReactNode; aside?: ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className={cx("flex items-end justify-between gap-4 hairline-b pb-3 mb-4 scroll-mt-24", className)}>
      <h2 className="font-display text-[26px] leading-none">{title}</h2>
      {aside ? <div className="text-[12px] text-muted font-mono">{aside}</div> : null}
    </div>
  );
}

/** Stack of overlapping token marks. */
export function TokenStack({ tokens, size = 24, max = 4 }: { tokens: { id: string; symbol: string; imageUrl: string | null }[]; size?: number; max?: number }) {
  const shown = tokens.slice(0, max);
  const rest = tokens.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((t, i) => (
        <span key={t.id} className="rounded-full ring-2 ring-paper" style={{ marginLeft: i === 0 ? 0 : -size * 0.3, zIndex: shown.length - i, position: "relative" }} title={t.symbol}>
          <TokenMark symbol={t.symbol} imageUrl={t.imageUrl} size={size} />
        </span>
      ))}
      {rest > 0 ? <span className="ml-1.5 font-mono text-[11px] text-muted">+{rest}</span> : null}
    </div>
  );
}

/** "$CURE $620.25" chips for a delivery's allocations. */
export function AllocationChips({ allocations, total }: { allocations: DeliveryWithAllocations["allocations"]; total?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allocations.map((a) => (
        <span key={a.tokenId} className="inline-flex items-center gap-1.5 hairline rounded-full pl-1 pr-2 h-6 font-mono text-[11px] tabular-nums">
          <TokenMark symbol={a.token.symbol} imageUrl={a.token.imageUrl} size={16} />${a.token.symbol}
          <span className="text-muted">{usdCents(a.amountUsdc)}</span>
          {total ? <span className="text-muted">{Math.round((a.amountUsdc / total) * 100)}%</span> : null}
        </span>
      ))}
    </div>
  );
}

/** Receipt-style delivery row used on vault and cause pages. */
export function DeliveryRow({ d, receiptNo, vaultLabel }: { d: DeliveryWithAllocations; receiptNo: string; vaultLabel?: string }) {
  const { delivery } = d;
  const when = delivery.deliveredAt ?? delivery.fundedAt ?? delivery.queuedAt;
  return (
    <Link href={`/r/${delivery.id}`} className="group grid grid-cols-[auto_1fr] sm:grid-cols-[96px_110px_1fr_auto] items-start gap-x-4 gap-y-2 py-3.5 rule-dashed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
      <span className="font-mono text-[13px] tracking-wide">{receiptNo}</span>
      <span className="font-mono text-[12px] text-muted tabular-nums">{new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
      <span className="col-span-2 sm:col-span-1 flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[15px] tabular-nums">{usdCents(delivery.amountUsdc)}</span>
          <RailPill rail={delivery.rail} />
          <StatusPill status={delivery.status} />
          {vaultLabel ? <span className="text-[12px] text-muted">{vaultLabel}</span> : null}
        </span>
        <AllocationChips allocations={d.allocations} />
      </span>
      <span className="hidden sm:inline font-mono text-[12px] text-muted group-hover:text-ink transition-colors">receipt →</span>
    </Link>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cx("hit underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp", className)}>
      {children}
    </a>
  );
}
