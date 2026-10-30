"use client";

import { ReactLenis } from "lenis/react";
import "lenis/dist/lenis.css";
import { useSyncExternalStore, type ReactNode } from "react";
import { AuthConfigContext } from "@/components/auth/config";
import { FeeRouterAuthProvider } from "@/components/auth/provider";

/** Inlined at build from GOOGLE_CLIENT_ID presence (next.config.ts). Only gates the sign-in button; sessions load regardless. */
const GOOGLE_CONFIGURED = process.env.NEXT_PUBLIC_GOOGLE_AUTH_CONFIGURED === "1";

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Smooth scroll. Reduced-motion users get native scrolling; the Lenis context stays mounted so `useLenis` consumers keep working. */
function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
  return (
    <ReactLenis root options={reduced ? { smoothWheel: false, syncTouch: false, lerp: 1 } : { lerp: 0.1 }}>
      {children}
    </ReactLenis>
  );
}

/** Client-side providers: session state (Google sign-in when configured), then Lenis. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthConfigContext.Provider value={{ configured: GOOGLE_CONFIGURED }}>
      <FeeRouterAuthProvider configured={GOOGLE_CONFIGURED}>
        <SmoothScroll>{children}</SmoothScroll>
      </FeeRouterAuthProvider>
    </AuthConfigContext.Provider>
  );
}
