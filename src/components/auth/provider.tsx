"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionUser } from "@/lib/auth/types";

export interface FeeRouterAuth {
  /** Session user (users row + `gmailConnected`), present once `/api/auth/session` answered. */
  user: SessionUser | null;
  /** True once the session lookup settled (signed out or signed in). */
  ready: boolean;
  /** False when Google sign-in is not configured on the server. */
  configured: boolean;
  /** Why the last sign-in attempt did not complete (from `?auth_error=`), else null. */
  error: string | null;
  /** Navigate to Google. `next` defaults to the current path. `scope: "operator"` also asks for Gmail. */
  login(opts?: { next?: string; scope?: "operator" }): void;
  logout(): Promise<void>;
}

const UNCONFIGURED: FeeRouterAuth = { user: null, ready: true, configured: false, error: null, login() {}, async logout() {} };

export const FeeRouterAuthContext = createContext<FeeRouterAuth>(UNCONFIGURED);

export function useFeeRouterUser(): FeeRouterAuth {
  return useContext(FeeRouterAuthContext);
}

const AUTH_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "The sign-in link expired. Try again.",
  state: "The sign-in response did not match this browser. Try again.",
  exchange: "Google did not complete the sign-in. Try again.",
  google: "Google returned an error. Try again.",
  gmail: "Signed in, but Gmail access was not granted. Use Connect Gmail to retry.",
  unverified: "Google has not verified this account's email address. Verify it with Google, then sign in again.",
};

/** Build the sign-in URL: current path (or `next`) survives the Google round trip. */
export function googleLoginHref(opts?: { next?: string; scope?: "operator" }): string {
  const next = opts?.next ?? `${window.location.pathname}${window.location.search}`;
  const p = new URLSearchParams({ next });
  if (opts?.scope === "operator") p.set("scope", "operator");
  return `/api/auth/google?${p.toString()}`;
}

/**
 * Loads the server session once on mount and exposes it to the tree. Sign-in is a full-page
 * navigation to `/api/auth/google`; sign-out revokes the cookie session and refreshes the RSC tree.
 */
export function FeeRouterAuthProvider({ configured, children }: { configured: boolean; children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((r) => r.json() as Promise<{ ok: true; data: SessionUser | null } | { ok: false; error: string }>)
      .then((body) => {
        if (cancelled) return;
        setUser(body.ok ? body.data : null);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface `?auth_error=` once, then drop it from the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("auth_error");
    if (!code) return;
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", url);
    // Deferred: the error is external (URL) state surfaced after the URL is cleaned.
    void Promise.resolve().then(() => setError(AUTH_ERRORS[code] ?? "Sign-in did not complete."));
  }, []);

  // `requireSession` bounces to `/?login=1`: start Google sign-in straight away when configured.
  useEffect(() => {
    if (!ready || user || !configured) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("login") !== "1") return;
    url.searchParams.delete("login");
    window.history.replaceState(window.history.state, "", url);
    window.location.assign(googleLoginHref({ next: `${url.pathname}${url.search}` }));
  }, [ready, user, configured]);

  const login = useCallback(
    (opts?: { next?: string; scope?: "operator" }) => {
      if (!configured) return;
      window.location.assign(googleLoginHref(opts));
    },
    [configured],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setUser(null);
    router.refresh();
  }, [router]);

  const value = useMemo<FeeRouterAuth>(() => ({ user, ready, configured, error, login, logout }), [user, ready, configured, error, login, logout]);
  return <FeeRouterAuthContext.Provider value={value}>{children}</FeeRouterAuthContext.Provider>;
}
