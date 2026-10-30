import Link from "next/link";
import { Marquee } from "@/components/motion";
import type { DeliveryTickerItem } from "@/lib/db/queries";
import { receiptNo, usdCents } from "@/lib/format";
import { RAIL_LABEL } from "./rail-labels";

/** Recent deliveries, one line each, looping. */
export function Ticker({ items }: { items: DeliveryTickerItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="hairline-t hairline-b bg-paper">
      <Marquee duration={Math.max(30, items.length * 7)} className="py-1">
        {items.map((d) => (
          <Link key={d.id} href={`/r/${d.id}`} className="inline-flex min-h-10 items-center gap-3 px-6 font-mono text-[12px] tabular-nums text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stamp">
            <span className="text-ink">{receiptNo(d.ordinal)}</span>
            <span className="text-muted">·</span>
            <span className="text-ink">{usdCents(d.amountUsdc)}</span>
            <span className="text-stamp">→</span>
            <span>{d.causeTitle}</span>
            <span className="text-muted">·</span>
            <span>via {RAIL_LABEL[d.rail]}</span>
            {d.topSymbol && (
              <>
                <span className="text-muted">·</span>
                <span>${d.topSymbol}</span>
              </>
            )}
            <span className="ml-3 text-muted">/</span>
          </Link>
        ))}
      </Marquee>
    </div>
  );
}
