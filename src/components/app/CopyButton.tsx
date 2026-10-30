"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";

/** Inline copy affordance for addresses, hashes and URLs. */
export function CopyButton({ value, label = "copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
        } catch {
          /* clipboard unavailable (insecure context); the value is visible on screen anyway */
        }
      }}
      className={cx("inline-flex min-h-10 min-w-10 items-center gap-1 -my-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted hover:text-ink transition-colors rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp", className)}
      aria-live="polite"
    >
      {done ? "copied" : label}
    </button>
  );
}

/** Copies the current page URL. */
export function ShareButton({ className }: { className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={async () => {
        const url = window.location.href;
        if (navigator.share) {
          try {
            await navigator.share({ url, title: document.title });
            return;
          } catch {
            /* user dismissed; fall through to clipboard */
          }
        }
        try {
          await navigator.clipboard.writeText(url);
          setDone(true);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className={cx("inline-flex items-center justify-center gap-2 rounded-sm px-4 h-10 text-[13px] font-medium tracking-tight hairline hover:bg-paper-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp", className)}
    >
      {done ? "Link copied" : "Share"}
    </button>
  );
}
