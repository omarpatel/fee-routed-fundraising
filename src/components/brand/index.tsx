import { cx } from "@/components/ui";

/* ------------------------------------------------------------------
   Fee Router text mark: mark, wordmark, logo. Inks in currentColor.
   ------------------------------------------------------------------ */

/** Square "FR" monogram. Inks in `currentColor`. */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={cx("shrink-0", className)} aria-hidden="true">
      <rect x={1.5} y={1.5} width={29} height={29} stroke="currentColor" strokeWidth={2} />
      <text x={16} y={21.5} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={14} fontWeight={700} fill="currentColor">
        FR
      </text>
    </svg>
  );
}

/** Plain-text `fee router` wordmark. Scale with font size. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cx("shrink-0 font-mono text-[15px] font-semibold tracking-tight", className)}>fee router</span>;
}

/** Mark + wordmark lockup. */
export function Logo({ className, markSize = 22 }: { className?: string; markSize?: number }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-ink", className)}>
      <Mark size={markSize} />
      <Wordmark />
    </span>
  );
}
