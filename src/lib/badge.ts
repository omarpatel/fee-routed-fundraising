import type { VaultBadge } from "@/lib/db/queries";
import { count, usd } from "@/lib/format";

/** Brand tokens from globals.css; an embedded SVG cannot read our CSS variables. */
const INK = "#101010";
const PAPER = "#f3efe6";
const STAMP = "#e4321b";
const LINE = "rgba(16,16,16,0.32)";

const HEIGHT = 20;
const PAD = 8;
/** Advance of an 11px monospace glyph (0.6em); `textLength` pins the text to it whatever font renders. */
const CHAR_W = 6.6;
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
/** Token symbols are user input; keep one from stretching the badge. */
const MAX_SYMBOL = 12;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** The right-hand text: which token funds the vault, what it delivered, how many receipts prove it. */
export function badgeText(b: VaultBadge): string {
  const funder = b.symbols.length === 1 ? `$${clip(b.symbols[0], MAX_SYMBOL)}` : b.symbols.length > 1 ? `${count(b.symbols.length)} tokens` : null;
  const receipts = `${count(b.deliveryCount)} receipt${b.deliveryCount === 1 ? "" : "s"}`;
  return [funder, `${usd(b.deliveredUsd)} delivered`, receipts].filter(Boolean).join(" · ");
}

/** "fee-router. | $CURE · $4,210 delivered · 3 receipts", shields-style, for fundraiser pages and READMEs. */
export function vaultBadgeSvg(b: VaultBadge): string {
  const text = badgeText(b);
  const leftW = Math.round(PAD * 2 + 6 * CHAR_W);
  const textW = Math.round([...text].length * CHAR_W * 10) / 10;
  const rightW = PAD * 2 + textW;
  const width = Math.ceil(leftW + rightW);
  const label = `Fee Router: ${text}`;
  const y = 14;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${esc(label)}">`,
    `<title>${esc(label)}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="3"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${leftW}" height="${HEIGHT}" fill="${INK}"/>`,
    `<rect x="${leftW}" width="${width - leftW}" height="${HEIGHT}" fill="${PAPER}"/>`,
    `</g>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${HEIGHT - 1}" rx="2.5" fill="none" stroke="${LINE}"/>`,
    `<g font-family="${FONT}" font-size="11">`,
    `<text x="${PAD}" y="${y}" fill="${PAPER}" textLength="${5 * CHAR_W}" lengthAdjust="spacingAndGlyphs">fee-router</text>`,
    `<text x="${PAD + 5 * CHAR_W}" y="${y}" fill="${STAMP}">.</text>`,
    `<text x="${leftW + PAD}" y="${y}" fill="${INK}" textLength="${textW}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
