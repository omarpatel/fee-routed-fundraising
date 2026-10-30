"use client";

import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { compactUsd, count, usd, usdCents } from "@/lib/format";
import { cx } from "@/components/ui";

type CounterKind = "usd" | "usdCents" | "compactUsd" | "int";
const FORMAT: Record<CounterKind, (n: number) => string> = { usd, usdCents, compactUsd, int: count };

/** Rolling number. Renders the final value on the server, counts up from zero once scrolled into view. */
export function Counter({ value, kind = "int", duration = 1.6, className }: { value: number; kind?: CounterKind; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const reduce = useReducedMotion();
  const fmt = FORMAT[kind];

  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = fmt(v);
      },
    });
    return () => controls.stop();
  }, [inView, value, duration, reduce, fmt]);

  return (
    <span ref={ref} className={cx("tabular-nums", className)}>
      {fmt(value)}
    </span>
  );
}
