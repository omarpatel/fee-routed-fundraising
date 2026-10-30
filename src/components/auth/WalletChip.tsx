"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { short } from "@/lib/format";

/** Mono wallet address with a copy affordance. `full` shows the whole address instead of Ab3d…9xYz. */
export function WalletChip({ address, full, className }: { address: string; full?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => setCopied(true));
      }}
      title={address}
      aria-label={`Copy wallet address ${address}`}
      className={cx(
        "group inline-flex items-center gap-1.5 h-7 px-2 rounded-sm hairline bg-paper font-mono text-[12px] tabular-nums text-ink hover:bg-paper-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp",
        className,
      )}
    >
      <span className={cx(full && "break-all text-left")}>{full ? address : short(address)}</span>
      <span aria-live="polite" className={cx("text-[10px] uppercase tracking-[0.12em]", copied ? "text-verify" : "text-muted group-hover:text-ink")}>
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
