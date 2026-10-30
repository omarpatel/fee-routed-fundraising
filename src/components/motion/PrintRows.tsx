"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { Children, useState, type ReactNode } from "react";

const EASE = [0.16, 1, 0.3, 1] as const;

const row: Variants = {
  hidden: (i: number) => ({ opacity: 0, y: 10, x: ((i * 7) % 3) - 1 }),
  visible: { opacity: 1, y: 0, x: 0, transition: { duration: 0.32, ease: EASE } },
};

/**
 * Receipt "printing": direct children reveal top-to-bottom with a slight
 * paper-feed jitter. `after` (typically a Stamp) mounts once the last row has printed.
 */
export function PrintRows({ children, after, delay = 0.4, stagger = 0.1, className, inView = true }: { children: ReactNode; after?: ReactNode; delay?: number; stagger?: number; className?: string; inView?: boolean }) {
  const reduce = useReducedMotion();
  const [done, setDone] = useState(false);
  const rows = Children.toArray(children);
  const container: Variants = { hidden: {}, visible: { transition: { delayChildren: delay, staggerChildren: stagger } } };
  const trigger = inView ? { whileInView: "visible" as const, viewport: { once: true, margin: "-5% 0px" } } : { animate: "visible" as const };

  if (reduce) {
    return (
      <div className={className}>
        {rows}
        {after}
      </div>
    );
  }

  return (
    <motion.div className={className} variants={container} initial="hidden" {...trigger} onAnimationComplete={() => setDone(true)}>
      {rows.map((r, i) => (
        <motion.div key={i} custom={i} variants={row}>
          {r}
        </motion.div>
      ))}
      {done && after}
    </motion.div>
  );
}
