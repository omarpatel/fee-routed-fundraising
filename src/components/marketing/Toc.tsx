"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";

/** Sticky table of contents; highlights the section currently in view. */
export function Toc({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => e !== null);
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);
  return (
    <nav aria-label="On this page" className="font-mono text-[12px]">
      <ol>
        {items.map((i, n) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className={cx("flex min-h-10 items-baseline gap-3 py-1 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp", active === i.id ? "text-ink" : "text-muted")}>
              <span className={cx("w-5 text-[10px]", active === i.id ? "text-stamp" : "text-muted")}>{String(n + 1).padStart(2, "0")}</span>
              {i.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
