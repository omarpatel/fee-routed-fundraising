import { ImageResponse } from "next/og";

export const alt = "Fee Router — Fund anyone on the internet.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#F3EFE6";
const PAPER_2 = "#EAE5D9";
const INK = "#101010";
const MUTED = "#6E6B64";
const STAMP = "#E4321B";
const LINE = "rgba(16,16,16,0.32)";

type Font = { name: string; data: ArrayBuffer; weight: 400; style: "normal" | "italic" };

/** Pull a TTF from Google Fonts. Returns null offline so the image still renders with the default face. */
async function googleFont(family: string, italic: boolean, name: string): Promise<Font | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}${italic ? ":ital@1" : ""}&display=swap`, {
      // Legacy UA makes Google return plain TTF sources, which Satori can consume.
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:27.0) Gecko/20100101 Firefox/27.0" },
      next: { revalidate: 60 * 60 * 24 },
    }).then((r) => (r.ok ? r.text() : null));
    const url = css?.match(/src:\s*url\(([^)]+)\)\s*format\(['"](?:truetype|opentype|woff)['"]\)/)?.[1];
    if (!url) return null;
    const data = await fetch(url, { next: { revalidate: 60 * 60 * 24 } }).then((r) => (r.ok ? r.arrayBuffer() : null));
    return data ? { name, data, weight: 400, style: italic ? "italic" : "normal" } : null;
  } catch {
    return null;
  }
}

export default async function OpenGraphImage() {
  const fonts = (await Promise.all([googleFont("Instrument+Serif", false, "Instrument Serif"), googleFont("Instrument+Serif", true, "Instrument Serif"), googleFont("Geist+Mono", false, "Geist Mono")])).filter((f): f is Font => f !== null);
  const serif = fonts.some((f) => f.name === "Instrument Serif") ? "Instrument Serif" : "serif";
  const mono = fonts.some((f) => f.name === "Geist Mono") ? "Geist Mono" : "monospace";
  // Satori refuses an empty font list; omit it so next/og falls back to its bundled face when offline.
  const options = fonts.length > 0 ? { ...size, fonts } : size;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: PAPER, color: INK, padding: "56px 64px 0", position: "relative" }}>
        {/* Header line: mark + ticker */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${STAMP}`, color: STAMP, fontFamily: mono, fontSize: 18, fontWeight: 700 }}>FR</div>
            <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: 3, color: MUTED }}>FEE ROUTER · PAYMENT LAYER</div>
          </div>
          <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: 3, color: MUTED }}>$ROUTE</div>
        </div>

        {/* Wordmark + tagline */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
          <div style={{ display: "flex", fontFamily: serif, fontSize: 150, lineHeight: 0.9, letterSpacing: -6 }}>
            <span>fee-router</span>
            <span style={{ color: STAMP }}>.</span>
          </div>
          <div style={{ display: "flex", fontFamily: serif, fontStyle: "italic", fontSize: 50, marginTop: 24, color: INK }}>Fund anyone on the internet.</div>
        </div>

        {/* Receipt strip */}
        <div style={{ position: "absolute", left: 64, right: 64, bottom: 0, display: "flex", flexDirection: "column", background: PAPER_2, padding: "14px 28px 26px" }}>
          <svg width="1016" height="2" viewBox="0 0 1016 2" style={{ marginBottom: 18 }}>
            <line x1="0" y1="1" x2="1016" y2="1" stroke={LINE} strokeWidth="2" strokeDasharray="6 6" />
          </svg>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: mono, fontSize: 18, letterSpacing: 1 }}>
            <div style={{ display: "flex", gap: 32 }}>
              <span style={{ color: MUTED }}>RECEIPT No. 000184</span>
              <span>2,400.00 USD</span>
              <span style={{ color: MUTED }}>VISA •••• 4821</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <span style={{ color: MUTED }}>SHA-256 9f3a…c21e</span>
              <span style={{ display: "flex", border: `3px solid ${STAMP}`, color: STAMP, borderRadius: 6, padding: "6px 12px", fontSize: 16, letterSpacing: 3, transform: "rotate(-4deg)" }}>DELIVERED</span>
            </div>
          </div>
        </div>
      </div>
    ),
    options,
  );
}
