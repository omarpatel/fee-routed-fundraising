import Link from "next/link";
import { Eyebrow, StatusPill } from "@/components/ui";
import type { VaultCard as VaultCardModel } from "@/lib/db/queries";
import { compactUsd, count, timeAgo, usd } from "@/lib/format";
import { CheckGlyph, PlatformPill, ProgressBar, TokenStack } from ".";

export function VaultCard({ v, heading: Heading = "h3" }: { v: VaultCardModel; heading?: "h2" | "h3" }) {
  const { vault, cause, totals, tokens } = v;
  const goal = cause.goalUsd ?? 0;
  const raised = totals.causeDeliveredUsd + (cause.raisedExternalUsd ?? 0);
  const progress = goal > 0 ? raised / goal : 0;
  return (
    <Link href={`/v/${vault.slug}`} className="group flex flex-col bg-paper hairline rounded-lg overflow-hidden outline-2 outline-offset-0 outline-transparent hover:outline-ink focus-visible:outline-stamp transition-[outline-color] duration-150">
      <div className="relative aspect-[16/9] bg-paper-2 overflow-hidden">
        {cause.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cause.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        ) : null}
        <div className="absolute left-3 top-3 flex gap-2">
          <PlatformPill platform={cause.platform} />
          {cause.verificationStatus === "verified" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-paper/90 px-2 h-6 font-mono text-[11px] uppercase tracking-[0.12em] text-verify">
              <CheckGlyph /> verified
            </span>
          ) : null}
        </div>
        <div className="absolute right-3 top-3">
          <StatusPill status={vault.status} />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div>
          <Heading className="font-display text-[24px] leading-[1.05]">{vault.name}</Heading>
          <p className="mt-1.5 text-[13px] text-ink-2 line-clamp-2">{cause.title}</p>
        </div>

        <div className="flex items-center justify-between">
          <TokenStack tokens={tokens} />
          <span className="font-mono text-[11px] text-muted uppercase tracking-[0.12em]">
            {tokens.length} token{tokens.length === 1 ? "" : "s"}
          </span>
        </div>

        <dl className="grid grid-cols-3 gap-3 hairline-t pt-4">
          <div>
            <dt>
              <Eyebrow>Delivered</Eyebrow>
            </dt>
            <dd className="mt-1 font-mono text-[17px] tabular-nums">{compactUsd(totals.deliveredUsd)}</dd>
          </div>
          <div>
            <dt>
              <Eyebrow>Fees routed</Eyebrow>
            </dt>
            <dd className="mt-1 font-mono text-[17px] tabular-nums">{compactUsd(totals.feesUsd)}</dd>
          </div>
          <div>
            <dt>
              <Eyebrow>Receipts</Eyebrow>
            </dt>
            <dd className="mt-1 font-mono text-[17px] tabular-nums">{count(totals.deliveryCount)}</dd>
          </div>
        </dl>

        <div>
          <ProgressBar value={progress} />
          <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-muted tabular-nums">
            <span>{goal > 0 ? `${usd(raised)} of ${usd(goal)} goal` : `${usd(raised)} raised`}</span>
            <span>{totals.lastDeliveryAt ? `last receipt ${timeAgo(totals.lastDeliveryAt)}` : "no receipts yet"}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
