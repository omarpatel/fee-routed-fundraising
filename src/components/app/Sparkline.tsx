/** Tiny inline SVG sparkline. Server-rendered; no client JS. */
export function Sparkline({ points, width = 120, height = 28, className, tone = "ink" }: { points: number[]; width?: number; height?: number; className?: string; tone?: "ink" | "paper" }) {
  if (points.length === 0) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="2 3" />
      </svg>
    );
  }
  const max = Math.max(...points, 1e-9);
  const pad = 2;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => [pad + i * stepX, height - pad - (p / max) * (height - pad * 2)] as const);
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${d} L${coords[coords.length - 1][0].toFixed(1)} ${height - pad} L${pad} ${height - pad} Z`;
  const stroke = tone === "paper" ? "var(--paper)" : "var(--ink)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role="img" aria-label={`Fees per day, ${points.length} days`}>
      <path d={area} fill={stroke} fillOpacity="0.08" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
