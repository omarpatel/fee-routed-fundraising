"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, type CSSProperties } from "react";
import { cx } from "@/components/ui";

gsap.registerPlugin(ScrollTrigger);

export interface FlowNode {
  label: string;
  sub: string;
  /** Marker colour once inked. Default ink. */
  tone?: "ink" | "stamp" | "usdc" | "verify";
}

const TONE: Record<NonNullable<FlowNode["tone"]>, string> = { ink: "var(--ink)", stamp: "var(--stamp)", usdc: "var(--usdc)", verify: "var(--verify)" };
const MARKER = 14;

type Pt = { x: number; y: number };

function polyline(points: Pt[]): { d: string; length: number; at: (t: number) => Pt } {
  if (points.length === 0) return { d: "", length: 0, at: () => ({ x: 0, y: 0 }) };
  const segs: number[] = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segs.push(l);
    length += l;
  }
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const at = (t: number): Pt => {
    let rem = Math.max(0, Math.min(1, t)) * length;
    for (let i = 0; i < segs.length; i++) {
      if (rem <= segs[i] || i === segs.length - 1) {
        const k = segs[i] === 0 ? 0 : rem / segs[i];
        return { x: points[i].x + (points[i + 1].x - points[i].x) * k, y: points[i].y + (points[i + 1].y - points[i].y) * k };
      }
      rem -= segs[i];
    }
    return points[points.length - 1];
  };
  return { d, length, at };
}

/**
 * Scroll-driven money-flow diagram. Nodes lay out with CSS (row on md+, column
 * below); the SVG path is measured from the markers, so both orientations share
 * one implementation. A red dollar dot travels the path as the section scrolls
 * (gsap ScrollTrigger scrub) and each node inks in as the dot passes.
 */
export function FlowDiagram({ nodes, className }: { nodes: FlowNode[]; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const track = useRef<SVGPathElement>(null);
  const drawn = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !svg.current || !track.current || !drawn.current || !dot.current) return;
    const markers = Array.from(el.querySelectorAll<HTMLElement>("[data-marker]"));
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-node]"));
    let geom = polyline([]);

    const measure = () => {
      const box = el.getBoundingClientRect();
      const pts = markers.map((m) => {
        const r = m.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      });
      geom = polyline(pts);
      svg.current!.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
      track.current!.setAttribute("d", geom.d);
      drawn.current!.setAttribute("d", geom.d);
      drawn.current!.style.strokeDasharray = `${geom.length}`;
    };

    const state = { p: 0 };
    const render = () => {
      const p = state.p;
      drawn.current!.style.strokeDashoffset = `${geom.length * (1 - p)}`;
      const pt = geom.at(p);
      dot.current!.setAttribute("cx", pt.x.toFixed(1));
      dot.current!.setAttribute("cy", pt.y.toFixed(1));
      dot.current!.style.opacity = p > 0.005 ? "1" : "0";
      const n = items.length;
      items.forEach((it, i) => {
        const threshold = n === 1 ? 0 : i / (n - 1) - 0.02;
        it.dataset.inked = p >= threshold ? "true" : "false";
      });
    };

    measure();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      state.p = 1;
      render();
      return;
    }
    render();

    const tween = gsap.to(state, {
      p: 1,
      ease: "none",
      onUpdate: render,
      scrollTrigger: { trigger: el.closest("[data-flow-scroll]") ?? el, start: "top 70%", end: "bottom 60%", scrub: 0.6 },
    });
    const ro = new ResizeObserver(() => {
      measure();
      render();
      ScrollTrigger.refresh();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, [nodes.length]);

  return (
    <div ref={root} className={cx("relative", className)}>
      <svg ref={svg} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" preserveAspectRatio="none">
        <path ref={track} fill="none" stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="3 5" />
        <path ref={drawn} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
        <circle ref={dot} r="7" fill="var(--stamp)" style={{ opacity: 0, transition: "opacity 0.2s" }} />
      </svg>
      <ol className="relative grid grid-cols-1 gap-10 md:grid-cols-[repeat(var(--n),minmax(0,1fr))] md:gap-4" style={{ "--n": nodes.length } as CSSProperties}>
        {nodes.map((n, i) => (
          <li key={n.label} data-node data-inked="false" className="group flex items-start gap-5 md:flex-col md:items-center md:gap-4 md:text-center" style={{ "--tone": TONE[n.tone ?? "ink"] } as CSSProperties}>
            <span data-marker className="relative z-10 mt-1 flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-paper transition-colors duration-300 group-data-[inked=true]:border-[var(--tone)] group-data-[inked=true]:bg-[var(--tone)] md:mt-0" style={{ width: MARKER * 2, height: MARKER * 2 }}>
              <span className="font-mono text-[10px] text-ink transition-colors duration-300 group-data-[inked=true]:text-paper">{String(i + 1).padStart(2, "0")}</span>
            </span>
            <span className="min-w-0 md:px-2">
              <span className="block font-display text-[22px] leading-tight text-muted transition-colors duration-300 group-data-[inked=true]:text-ink md:text-[20px] lg:text-[24px]">{n.label}</span>
              <span className="mt-1 block font-mono text-[11px] leading-snug text-muted">{n.sub}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
