"use client";

import { useCallback, useRef, useState } from "react";
import { Button, cx } from "@/components/ui";
import { useFeeRouterUser } from "./provider";
import { useDismiss } from "./useDismiss";
import { UserMenu } from "./UserMenu";

export { useFeeRouterUser, FeeRouterAuthProvider, googleLoginHref, type FeeRouterAuth } from "./provider";
export { AuthConfigContext } from "./config";
export { Avatar, UserMenu } from "./UserMenu";
export { WalletChip } from "./WalletChip";

/** Google "G" mark, four-colour, drawn inline so the header never waits on a remote asset. */
export function GoogleGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={cx("shrink-0", className)}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Ghost sign-in that opens a short explanation instead of navigating. */
function UnavailableButton({ title, detail, action }: { title: string; detail: string; action?: { label: string; onClick: () => void } }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="gap-2">
        <GoogleGlyph className="opacity-60 grayscale" />
        Sign in with Google
      </Button>
      {open && (
        <div role="dialog" className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 rounded-lg hairline bg-paper p-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-stamp">{title}</div>
          <p className="mt-1.5 text-[13px] text-ink-2">{detail}</p>
          {action && (
            <button type="button" onClick={action.onClick} className="mt-2 text-[12px] text-muted underline underline-offset-2 hover:text-ink">
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Header auth control. Signed in → avatar, wallet, menu. Signed out → "Sign in with Google";
 * not configured → the same button opens a note naming the missing env; a failed attempt shows why.
 */
export function AuthButton({ className }: { className?: string }) {
  const { user, ready, configured, error, login, logout } = useFeeRouterUser();

  if (user) return <UserMenu user={user} onLogout={logout} className={className} />;
  if (!configured) {
    return (
      <div className={className}>
        <UnavailableButton title="Sign-in not configured" detail="Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET, then restart." />
      </div>
    );
  }
  if (!ready) {
    return (
      <div className={className}>
        <Button variant="ghost" disabled aria-busy className="gap-2 text-muted">
          <GoogleGlyph className="opacity-60 grayscale" />
          Sign in with Google
        </Button>
      </div>
    );
  }
  if (error) {
    return (
      <div className={className}>
        <UnavailableButton title="Sign-in did not complete" detail={error} action={{ label: "Try again", onClick: () => login() }} />
      </div>
    );
  }
  return (
    <div className={className}>
      <Button variant="ghost" onClick={() => login()} className="gap-2">
        <GoogleGlyph />
        Sign in with Google
      </Button>
    </div>
  );
}
