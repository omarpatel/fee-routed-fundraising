"use client";

import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * Infinite horizontal ticker. Content is rendered twice and translated by
 * half its width; the CSS loop is seamless as long as both copies are equal.
 * Pauses on hover; static under prefers-reduced-motion.
 */
export function Marquee({ children, duration = 48, className }: { children: ReactNode; duration?: number; className?: string }) {
  return (
    <div className={cx("fee-router-marquee overflow-hidden whitespace-nowrap", className)} role="marquee">
      <style href="fee-router-marquee" precedence="default">{`
        @keyframes fee-router-marquee { from { transform: translate3d(0,0,0) } to { transform: translate3d(-50%,0,0) } }
        .fee-router-marquee > div { display: inline-flex; width: max-content; animation: fee-router-marquee var(--marquee-duration, 48s) linear infinite; will-change: transform }
        .fee-router-marquee:hover > div { animation-play-state: paused }
        @media (prefers-reduced-motion: reduce) { .fee-router-marquee > div { animation: none } }
      `}</style>
      <div style={{ "--marquee-duration": `${duration}s` } as React.CSSProperties}>
        <div className="inline-flex shrink-0">{children}</div>
        <div className="inline-flex shrink-0" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
