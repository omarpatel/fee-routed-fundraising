import Link from "next/link";
import { Mark } from "@/components/brand";
import { PrintRows } from "@/components/motion";
import { Stamp, cx } from "@/components/ui";
import type { ReceiptDetail } from "@/lib/db/queries";
import { dateShort, receiptNo, short, solscanTx, usdCents } from "@/lib/format";
import { RAIL_LABEL } from "./rail-labels";

function Line({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-2 rule-dashed", className)}>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="text-right font-mono text-[13px] tabular-nums">{value}</span>
    </div>
  );
}

/** The hero object: a real delivery receipt that prints itself, then gets stamped. */
export function HeroReceipt({ receipt }: { receipt: ReceiptDetail }) {
  const { delivery, cause, vault, allocations } = receipt;
  const sorted = [...allocations].sort((a, b) => b.amountUsdc - a.amountUsdc);
  return (
    <Link href={`/r/${delivery.id}`} className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stamp" aria-label={`Open receipt ${receiptNo(delivery.ordinal)}`}>
      <figure className="receipt-edge mx-auto w-full max-w-[420px] rotate-[-1.2deg] bg-[#faf8f2] py-1.5 transition-transform duration-500 ease-out-expo group-hover:rotate-0">
        <PrintRows className="relative px-6 pb-8 pt-7" delay={0.5} stagger={0.11} inView={false} after={
          <div className="absolute right-8 top-[41%]" style={{ fontSize: 38 }}>
            <Stamp animate>Delivered</Stamp>
          </div>
        }>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-ink">
              <Mark size={20} />
              <span className="font-display text-[22px] leading-none">
                fee-router<span className="text-stamp">.</span>
              </span>
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Receipt</span>
          </div>
          <div className="mt-5 flex items-baseline justify-between">
            <span className="font-mono text-[28px] leading-none tracking-tight">{receiptNo(delivery.ordinal)}</span>
            <span className="font-mono text-[11px] text-muted">{delivery.deliveredAt ? dateShort(delivery.deliveredAt) : "—"}</span>
          </div>
          <div className="mt-5 hairline-t" />
          <Line label="Cause" value={<span className="font-sans text-[13px] leading-snug">{cause.title}</span>} className="pt-3" />
          <Line label="Vault" value={vault.name} />
          <Line label="Rail" value={RAIL_LABEL[delivery.rail]} />
          <Line label="Amount" value={<span className="text-[15px]">{usdCents(delivery.amountUsdc)}</span>} />
          <div className="pt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Funded by</div>
          {sorted.map((a) => (
            <Line key={a.tokenId} label={`$${a.token.symbol}`} value={usdCents(a.amountUsdc)} />
          ))}
          <Line label="sha-256" value={delivery.receiptHash ? short(delivery.receiptHash, 8, 6) : "—"} className="pt-3" />
          <Line label="Anchor" value={delivery.anchorTxSig ? <span className="text-verify">{short(delivery.anchorTxSig, 6, 4)}</span> : "—"} />
          <div className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>{delivery.anchorTxSig ? new URL(solscanTx(delivery.anchorTxSig)).host : "unanchored"}</span>
            <span>Open receipt →</span>
          </div>
        </PrintRows>
      </figure>
    </Link>
  );
}

/** Before the first delivery: the same paper, blank lines, a queued stamp. Never a fake receipt. */
export function HeroReceiptEmpty() {
  return (
    <Link href="/connect" className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stamp" aria-label="Connect a fundraiser">
      <figure className="receipt-edge mx-auto w-full max-w-[420px] rotate-[-1.2deg] bg-[#faf8f2] py-1.5 transition-transform duration-500 ease-out-expo group-hover:rotate-0">
        <PrintRows className="relative px-6 pb-8 pt-7" delay={0.5} stagger={0.11} inView={false} after={
          <div className="absolute right-8 top-[41%]" style={{ fontSize: 38 }}>
            <Stamp animate className="text-ink! border-ink!">Awaiting</Stamp>
          </div>
        }>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-ink">
              <Mark size={20} />
              <span className="font-display text-[22px] leading-none">
                fee-router<span className="text-stamp">.</span>
              </span>
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Receipt</span>
          </div>
          <div className="mt-5 flex items-baseline justify-between">
            <span className="font-mono text-[28px] leading-none tracking-tight">{receiptNo(1)}</span>
            <span className="font-mono text-[11px] text-muted">not yet</span>
          </div>
          <div className="mt-5 hairline-t" />
          <Line label="Cause" value={<span className="font-sans text-[13px] leading-snug text-muted">the first connected fundraiser</span>} className="pt-3" />
          <Line label="Vault" value={<span className="text-muted">—</span>} />
          <Line label="Rail" value={<span className="text-muted">card or on-chain</span>} />
          <Line label="Amount" value={<span className="text-[15px] text-muted">$0.00</span>} />
          <div className="pt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Funded by</div>
          <Line label="$—" value={<span className="text-muted">creator fees</span>} />
          <Line label="sha-256" value={<span className="text-muted">computed at delivery</span>} className="pt-3" />
          <Line label="Anchor" value={<span className="text-muted">Solana memo</span>} />
          <div className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>this prints itself</span>
            <span>Connect a fundraiser →</span>
          </div>
        </PrintRows>
      </figure>
    </Link>
  );
}
