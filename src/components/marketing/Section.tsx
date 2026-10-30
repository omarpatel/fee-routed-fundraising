import type { ReactNode } from "react";
import { Reveal } from "@/components/motion";
import { Container, Eyebrow, cx } from "@/components/ui";

/** Numbered section header: mono eyebrow, display title, optional lede. */
export function SectionHead({ no, eyebrow, title, lede, className }: { no: string; eyebrow: string; title: ReactNode; lede?: ReactNode; className?: string }) {
  return (
    <Reveal className={cx("grid gap-6 md:grid-cols-12", className)}>
      <div className="flex items-baseline gap-4 md:col-span-3">
        <span className="font-mono text-[11px] text-stamp">{no}</span>
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>
      <div className="md:col-span-9">
        <h2 className="max-w-[18ch] text-balance font-display text-[clamp(34px,4.6vw,60px)] leading-[1.02] tracking-[-0.015em]">{title}</h2>
        {lede && <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-ink-2">{lede}</p>}
      </div>
    </Reveal>
  );
}

export function Section({ children, className, id, dark }: { children: ReactNode; className?: string; id?: string; dark?: boolean }) {
  return (
    <section id={id} className={cx("hairline-t py-20 md:py-28", dark && "ledger", className)}>
      <Container wide>{children}</Container>
    </section>
  );
}
