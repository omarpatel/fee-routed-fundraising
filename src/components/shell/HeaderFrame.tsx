"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";

/** Sticky paper bar. Flat at the top of the page; blurs and lightens once the page has scrolled. */
export function HeaderFrame({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={cx("sticky top-0 z-40 hairline-b transition-[background-color,backdrop-filter] duration-300", scrolled ? "bg-paper/85 backdrop-blur-md" : "bg-paper")} data-scrolled={scrolled}>
      {children}
    </header>
  );
}
