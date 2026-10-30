import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/* ------------------------------------------------------------------
   Shared primitives. Every surface uses these; nobody re-invents them.
   Paper/ink/stamp only. No shadows. Hairlines do the work.
   ------------------------------------------------------------------ */

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

type ButtonVariant = "ink" | "stamp" | "ghost" | "paper";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  ink: "bg-ink text-paper hover:bg-ink-2",
  stamp: "bg-stamp text-paper hover:bg-stamp-deep",
  ghost: "bg-transparent text-ink hairline hover:bg-paper-2",
  paper: "bg-paper text-ink hover:bg-paper-2",
};
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-sm px-4 h-10 text-[13px] font-medium tracking-tight transition-colors duration-150 select-none disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp";

export function Button({ variant = "ink", className, size, ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "lg" }) {
  return <button className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], size === "sm" && "h-8 px-3 text-[12px]", size === "lg" && "h-12 px-6 text-[15px]", className)} {...props} />;
}

export function ButtonLink({ variant = "ink", className, size, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: "sm" | "lg" }) {
  return <Link className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], size === "sm" && "h-8 px-3 text-[12px]", size === "lg" && "h-12 px-6 text-[15px]", className)} {...props} />;
}

/** Red inked stamp. Add `animate` to play the slam-in on mount. */
export function Stamp({ children, animate, className }: { children: ReactNode; animate?: boolean; className?: string }) {
  return <span className={cx("stamp", animate && "stamp-in", className)}>{children}</span>;
}

/** Mono label — small caps tracking, for eyebrows and column headers. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("font-mono text-[11px] uppercase tracking-[0.18em] text-muted", className)}>{children}</div>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[13px] tabular-nums", className)}>{children}</span>;
}

/** Hairline container. */
export function Panel({ children, className, as: As = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" | "aside" }) {
  return <As className={cx("hairline rounded-lg bg-paper", className)}>{children}</As>;
}

/** Ledger row: label left, value right, dashed rule underneath. */
export function Row({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-6 py-2.5 rule-dashed", className)}>
      <span className="text-[13px] text-muted">{label}</span>
      <span className="font-mono text-[13px] tabular-nums text-right">{value}</span>
    </div>
  );
}

type PillTone = "ink" | "verify" | "stamp" | "muted" | "usdc";
const PILL_TONE: Record<PillTone, string> = {
  ink: "bg-ink text-paper",
  verify: "bg-verify/10 text-verify border border-verify/30",
  stamp: "bg-stamp/10 text-stamp border border-stamp/30",
  muted: "bg-paper-2 text-ink-2 hairline",
  usdc: "bg-usdc/10 text-usdc border border-usdc/30",
};
export function Pill({ children, tone = "muted", className }: { children: ReactNode; tone?: PillTone; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 h-6 font-mono text-[11px] uppercase tracking-[0.12em] whitespace-nowrap", PILL_TONE[tone], className)}>{children}</span>;
}

const STATUS_TONE: Record<string, PillTone> = { delivered: "verify", queued: "muted", funding: "usdc", funded: "usdc", executing: "ink", failed: "stamp", reversed: "stamp", verified: "verify", pending: "muted", unverified: "muted", rejected: "stamp", active: "verify", paused: "muted", closed: "muted" };
export function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "muted"}>{status}</Pill>;
}

/** Page-width container. */
export function Container({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cx("mx-auto w-full px-5 sm:px-8", wide ? "max-w-[1440px]" : "max-w-[1200px]", className)}>{children}</div>;
}

/** Token avatar — image or two-letter mono fallback. */
export function TokenMark({ symbol, imageUrl, size = 24 }: { symbol: string; imageUrl?: string | null; size?: number }) {
  return imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={imageUrl} alt={symbol} width={size} height={size} className="rounded-full bg-paper-2 object-cover shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span className="inline-flex items-center justify-center rounded-full bg-ink text-paper font-mono text-[10px] shrink-0" style={{ width: size, height: size }}>
      {symbol.slice(0, 2)}
    </span>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("border-0 border-t border-line", className)} />;
}
