"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Pill, cx } from "@/components/ui";
import type { SessionUser } from "@/lib/auth/types";
import type { User } from "@/lib/db/schema";
import { short } from "@/lib/format";
import { googleLoginHref } from "./provider";
import { useDismiss } from "./useDismiss";
import { WalletChip } from "./WalletChip";

/** Round avatar: image when present, else the first letter of the name/email on ink. */
export function Avatar({ user, size = 28 }: { user: Pick<User, "name" | "email" | "avatarUrl">; size?: number }) {
  const label = user.name ?? user.email;
  return user.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={user.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" className="rounded-full bg-paper-2 object-cover shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden className="inline-flex items-center justify-center rounded-full bg-ink text-paper font-mono text-[11px] uppercase shrink-0" style={{ width: size, height: size }}>
      {label.slice(0, 1)}
    </span>
  );
}

const ITEM = "flex items-center justify-between gap-4 px-3 h-9 text-[13px] text-ink hover:bg-paper-2 focus-visible:bg-paper-2 focus-visible:outline-none";

/** Signed-in header control: avatar + short wallet, opening Dashboard / Ops / Admin / Connect Gmail / Sign out. */
export function UserMenu({ user, onLogout, className }: { user: SessionUser; onLogout: () => Promise<void>; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const canOps = user.role === "operator" || user.role === "admin";

  return (
    <div ref={ref} className={cx("relative", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-sm hairline bg-paper hover:bg-paper-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp"
      >
        <Avatar user={user} />
        <span className="font-mono text-[12px] tabular-nums">{short(user.walletAddress)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={cx("text-muted transition-transform", open && "rotate-180")}>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 rounded-lg hairline bg-paper overflow-hidden">
          <div className="px-3 py-3 hairline-b">
            <div className="flex items-center gap-2.5">
              <Avatar user={user} size={32} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate">{user.name ?? "Signed in"}</div>
                <div className="text-[12px] text-muted truncate">{user.email}</div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <WalletChip address={user.walletAddress} />
              {canOps && <Pill tone="stamp">{user.role}</Pill>}
            </div>
          </div>
          <div className="py-1">
            <Link role="menuitem" href="/dashboard" onClick={close} className={ITEM}>
              Dashboard
            </Link>
            {canOps && (
              <Link role="menuitem" href="/ops" onClick={close} className={ITEM}>
                Ops desk
              </Link>
            )}
            {user.role === "admin" && (
              <Link role="menuitem" href="/admin" onClick={close} className={ITEM}>
                Admin
              </Link>
            )}
            {canOps &&
              (user.gmailConnected ? (
                <div className={cx(ITEM, "text-muted cursor-default")} aria-disabled>
                  <span>Gmail</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-verify">connected</span>
                </div>
              ) : (
                <a role="menuitem" href={googleLoginHref({ next: "/ops", scope: "operator" })} className={ITEM}>
                  <span>Connect Gmail</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">required</span>
                </a>
              ))}
            <button
              role="menuitem"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onLogout();
                } finally {
                  setBusy(false);
                  setOpen(false);
                }
              }}
              className={cx(ITEM, "w-full text-left text-stamp disabled:opacity-40")}
            >
              {busy ? "Signing out" : "Sign out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
