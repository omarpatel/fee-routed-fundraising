"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ButtonLink, cx } from "@/components/ui";

export function MobileNav({ links, auth }: { links: { href: string; label: string }[]; auth: ReactNode }) {
  // Open state is keyed to the path it was opened on, so navigation closes it without an effect.
  const pathname = usePathname();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const open = openPath === pathname;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => setOpenPath((prev) => ((typeof next === "function" ? next(prev === pathname) : next) ? pathname : null));

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenPath(null);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button type="button" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)} className="flex h-10 w-10 items-center justify-center rounded-sm hairline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="stroke-ink" strokeWidth="1.5" strokeLinecap="square">
          {open ? (
            <>
              <path d="M3 3l12 12" />
              <path d="M15 3L3 15" />
            </>
          ) : (
            <>
              <path d="M2 5h14" />
              <path d="M2 9h14" />
              <path d="M2 13h14" />
            </>
          )}
        </svg>
      </button>
      <div id="mobile-nav" className={cx("fixed inset-x-0 top-[57px] bottom-0 z-40 flex flex-col bg-paper transition-opacity duration-200", open ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden={!open}>
        <nav className="flex flex-col hairline-b">
          {links.map((l, i) => (
            <Link key={l.href} href={l.href} className={cx("flex items-baseline justify-between px-5 py-5 font-display text-[34px] leading-none", i > 0 && "hairline-t", pathname === l.href && "text-stamp")}>
              {l.label}
              <span className="font-mono text-[11px] text-muted">{String(i + 1).padStart(2, "0")}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-5 py-6 hairline-t">
          <ButtonLink href="/launch" size="lg">
            Launch a vault
          </ButtonLink>
          <div className="flex justify-center">{auth}</div>
        </div>
      </div>
    </div>
  );
}
