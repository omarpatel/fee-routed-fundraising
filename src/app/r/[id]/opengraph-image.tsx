import { ImageResponse } from "next/og";
import { getReceipt } from "@/lib/db/queries";
import { verifyReceipt } from "@/lib/proof";
import { dateShort, publicFailureReason, receiptNo, usdCents } from "@/lib/format";
import { RAIL_LABEL } from "@/components/app";

export const alt = "Fee Router receipt";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#F3EFE6";
const PAPER_2 = "#EAE5D9";
const INK = "#101010";
const MUTED = "#6E6B64";
const STAMP = "#E4321B";
const VERIFY = "#1C9A4C";
const USDC = "#2775CA";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const r = await getReceipt((await params).id);
  if (!r) {
    return new ImageResponse(
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: PAPER, color: INK, fontSize: 48, fontFamily: "monospace" }}>Receipt not found</div>,
      size,
    );
  }
  const { delivery, cause, vault, allocations } = r;
  const v = verifyReceipt(r);
  const no = receiptNo(delivery.ordinal);
  const verified = delivery.status === "delivered" && v.ok;
  const stateLabel = delivery.status === "delivered" ? (verified ? "VERIFIED" : "UNVERIFIED") : delivery.status === "queued" ? "IN PROGRESS" : delivery.status.toUpperCase();
  const stateColor = verified ? VERIFY : delivery.status === "delivered" ? STAMP : MUTED;
  const amountLabel = delivery.status === "delivered" ? "AMOUNT DELIVERED" : delivery.status === "reversed" ? "AMOUNT REVERSED" : delivery.status === "failed" ? "AMOUNT NOT DELIVERED" : delivery.status === "queued" ? "AMOUNT QUEUED" : "AMOUNT IN FLIGHT";
  const failure = publicFailureReason(delivery);

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER_2, padding: 40, fontFamily: "monospace", color: INK }}>
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: PAPER, padding: "48px 56px", border: `1px solid rgba(16,16,16,0.12)` }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${INK}`, color: INK, fontFamily: "monospace", fontSize: 18, fontWeight: 700 }}>FR</div>
            <div style={{ display: "flex", fontSize: 40, letterSpacing: -1 }}>
              fee-router<span style={{ color: STAMP }}>.</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ fontSize: 16, letterSpacing: 4, color: MUTED }}>RECEIPT</div>
            <div style={{ fontSize: 44, letterSpacing: 2 }}>{no}</div>
          </div>
        </div>

        {/* amount */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 40, paddingTop: 28, paddingBottom: 28, borderTop: "1px solid rgba(16,16,16,0.2)", borderBottom: "1px solid rgba(16,16,16,0.2)" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 16, letterSpacing: 4, color: MUTED }}>{amountLabel}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 8 }}>
              <div style={{ fontSize: 96, lineHeight: 1, letterSpacing: -3 }}>{usdCents(delivery.amountUsdc)}</div>
              <div style={{ fontSize: 28, color: USDC }}>USDC</div>
            </div>
          </div>
          <div style={{ display: "flex", padding: "14px 22px", border: `4px solid ${stateColor}`, color: stateColor, fontSize: 30, letterSpacing: 5, transform: "rotate(-6deg)", borderRadius: 6 }}>{stateLabel}</div>
        </div>

        {/* lines */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 28, gap: 16, fontSize: 24 }}>
          <div style={{ display: "flex", gap: 24 }}>
            <div style={{ width: 130, color: MUTED, fontSize: 16, letterSpacing: 4, paddingTop: 6 }}>TO</div>
            <div style={{ display: "flex", flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{cause.title}</div>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <div style={{ width: 130, color: MUTED, fontSize: 16, letterSpacing: 4, paddingTop: 6 }}>FROM</div>
            <div style={{ display: "flex", flex: 1, gap: 12 }}>
              {vault.name}
              <span style={{ color: MUTED }}>{allocations.map((a) => `$${a.token.symbol}`).join(" · ")}</span>
            </div>
          </div>
          {/* A failed receipt's reason takes the rail row: the card has no room for both. */}
          <div style={{ display: "flex", gap: 24 }}>
            <div style={{ width: 130, color: MUTED, fontSize: 16, letterSpacing: 4, paddingTop: 6 }}>{failure ? "REASON" : "RAIL"}</div>
            {/* Satori rejects an explicit `undefined` style value, so the key is only set when it applies. */}
            <div style={{ display: "flex", flex: 1, ...(failure ? { fontSize: 18 } : {}) }}>{failure ?? RAIL_LABEL[delivery.rail]}</div>
          </div>
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto", fontSize: 18, color: MUTED }}>
          <div style={{ display: "flex" }}>{delivery.deliveredAt ? dateShort(delivery.deliveredAt) : `queued ${dateShort(delivery.queuedAt)}`}</div>
          <div style={{ display: "flex" }}>{v.anchoredHash ? `sha256 ${v.anchoredHash.slice(0, 16)}…${v.anchoredHash.slice(-8)}` : "Every dollar has a receipt."}</div>
        </div>
      </div>
    </div>,
    size,
  );
}
