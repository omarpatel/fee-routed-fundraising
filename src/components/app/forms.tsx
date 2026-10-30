"use client";

import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/components/ui";

/* Form primitives for the wizards and the operator desk. Hairlines, mono values, no chrome. */

const FIELD = "w-full rounded-sm bg-paper hairline px-3 h-10 text-[14px] text-ink placeholder:text-muted/70 focus:outline-2 focus:outline-offset-1 focus:outline-stamp disabled:opacity-50";

export function Field({ label, hint, children, className, required }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {label}
        {required ? <span className="text-stamp"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(FIELD, props.type === "number" && "font-mono tabular-nums", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(FIELD, "h-auto min-h-[96px] py-2 leading-[1.5]", className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cx(FIELD, "appearance-none pr-8 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 12 12%22><path d=%22M2 4l4 4 4-4%22 fill=%22none%22 stroke=%22%23101010%22 stroke-width=%221.5%22/></svg>')] bg-no-repeat bg-[right_10px_center]", className)} {...props}>
      {children}
    </select>
  );
}

/** Inline error/notice from the API envelope. */
export function Notice({ tone = "stamp", children, className }: { tone?: "stamp" | "verify" | "muted"; children: ReactNode; className?: string }) {
  const t = tone === "stamp" ? "border-stamp/40 text-stamp bg-stamp/5" : tone === "verify" ? "border-verify/40 text-verify bg-verify/5" : "border-line text-ink-2 bg-paper-2";
  return (
    <div role={tone === "stamp" ? "alert" : "status"} className={cx("rounded-sm border px-3 py-2 text-[13px] font-mono", t, className)}>
      {children}
    </div>
  );
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

/** Copyable mono block for addresses handed to the user. */
export function AddressBlock({ value, label }: { value: string; label?: string }) {
  return (
    <div className="rounded-sm hairline bg-paper-2 px-3 py-2.5">
      {label ? <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{label}</div> : null}
      <div className="mt-0.5 break-all font-mono text-[13px] tabular-nums select-all">{value}</div>
    </div>
  );
}
