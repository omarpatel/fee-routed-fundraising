import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header, Footer } from "@/components/shell";
import { Logo } from "@/components/brand";
import { Container, cx, Eyebrow, Pill, Stamp, StatusPill, TokenMark } from "@/components/ui";
import { CheckGlyph, ExternalLink, PLATFORM_LABEL, RAIL_LABEL, ReceiptPaper } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import { ReceiptDownload } from "@/components/app/ReceiptDownload";
import { getReceipt } from "@/lib/db/queries";
import type { ReceiptArtifact } from "@/lib/db/schema";
import { canonicalReceipt, verifyReceipt, MEMO_PREFIX } from "@/lib/proof";
import { dateShort, dateTime, publicFailureReason, receiptNo, short, solscanTx, usdCents } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await getReceipt((await params).id);
  if (!r) return { title: "Receipt not found" };
  const no = receiptNo(r.delivery.ordinal);
  const failure = publicFailureReason(r.delivery);
  return {
    title: `${no} · ${usdCents(r.delivery.amountUsdc)} to ${r.cause.title}`,
    description: failure ? `${r.vault.name} → ${r.cause.title}, ${usdCents(r.delivery.amountUsdc)} USDC: ${failure}` : `${r.vault.name} delivered ${usdCents(r.delivery.amountUsdc)} USDC to ${r.cause.title} via ${RAIL_LABEL[r.delivery.rail]}.`,
  };
}

const ARTIFACT_LABEL: Record<ReceiptArtifact["kind"], string> = {
  screenshot: "Screenshot",
  confirmation_email: "Email",
  card_statement: "Statement",
  platform_receipt: "Platform receipt",
  onchain_tx: "On-chain tx",
  other: "File",
};

function ArtifactGlyph({ kind }: { kind: ReceiptArtifact["kind"] }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden className="text-ink-2 shrink-0">
      {kind === "screenshot" ? (
        <>
          <rect x="2.5" y="4" width="15" height="12" rx="1" {...common} />
          <path d="M2.5 13l4-4 3 3 3-3 5 5" {...common} />
        </>
      ) : kind === "confirmation_email" ? (
        <>
          <rect x="2.5" y="4.5" width="15" height="11" rx="1" {...common} />
          <path d="M3 5.5l7 5 7-5" {...common} />
        </>
      ) : kind === "card_statement" ? (
        <>
          <rect x="2.5" y="5" width="15" height="10" rx="1" {...common} />
          <path d="M2.5 8.5h15M5.5 12h3" {...common} />
        </>
      ) : kind === "onchain_tx" ? (
        <>
          <path d="M7 12.5l-2 2a2.5 2.5 0 01-3.5-3.5l3-3a2.5 2.5 0 013.5 0" {...common} />
          <path d="M13 7.5l2-2a2.5 2.5 0 013.5 3.5l-3 3a2.5 2.5 0 01-3.5 0" {...common} />
          <path d="M8 12l4-4" {...common} />
        </>
      ) : (
        <>
          <path d="M5 2.5h7l4 4v11H5z" {...common} />
          <path d="M12 2.5v4h4" {...common} />
        </>
      )}
    </svg>
  );
}

function Line({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("grid grid-cols-[88px_1fr] sm:grid-cols-[120px_1fr] gap-4 py-3 rule-dashed", className)}>
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted pt-0.5">{label}</div>
      <div className="min-w-0 text-[14px]">{children}</div>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getReceipt(id);
  if (!r) notFound();
  const { delivery, vault, cause, allocations, artifacts, period } = r;
  const canonical = canonicalReceipt(r);
  const v = verifyReceipt(r);
  const no = receiptNo(delivery.ordinal);
  const delivered = delivery.status === "delivered";
  const state = delivered ? null : delivery.status === "queued" ? "IN PROGRESS" : delivery.status.toUpperCase();
  const fiatDiffers = delivery.amountFiat !== null && (delivery.fiatCurrency !== "USD" || delivery.amountFiat !== delivery.amountUsdc);
  const railText = delivery.rail === "onchain" ? (delivery.railRef ? "USDC transfer on Solana" : "USDC transfer on Solana (pending)") : `${RAIL_LABEL[delivery.rail]}${delivery.railRef ? ` · ${delivery.railRef}` : ""}`;
  const failure = publicFailureReason(delivery);
  const reason = !v.anchoredHash ? (delivered ? "No receipt hash was recorded for this delivery." : failure ? "This delivery did not complete, so no receipt hash was sealed." : "Hash is computed when the operator finalizes the delivery.") : v.anchoredHash !== v.computedHash ? "Recomputed hash does not match the recorded hash. The receipt fields changed after finalization." : !v.anchorTxSig ? "Hash matches but no anchor transaction is recorded." : null;

  return (
    <>
      <Header />
      <main className="flex-1 bg-paper-2/60">
        <Container className="pt-10 pb-24">
          <div className="mx-auto max-w-[640px]">
            <nav className="mb-4 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
              <Link href={`/v/${vault.slug}`} className="hit hover:text-ink">
                ← {vault.name}
              </Link>
              <span>Receipt {no}</span>
            </nav>

            <ReceiptPaper as="article" className="font-mono" inner="px-6 sm:px-10 py-9">
              {/* header */}
              <header className="flex items-start justify-between gap-4">
                <Logo markSize={26} />
                <div className="text-right">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Receipt</div>
                  <h1 className="text-[22px] tracking-wide leading-none mt-1 font-normal">{no}</h1>
                </div>
              </header>
              <div className="mt-6 flex items-center justify-between text-[12px] text-muted">
                <span>{delivered && delivery.deliveredAt ? dateTime(delivery.deliveredAt) : `queued ${dateTime(delivery.queuedAt)}`}</span>
                <StatusPill status={delivery.status} />
              </div>

              {/* stamp / state */}
              <div className="relative mt-6 hairline-t hairline-b py-6 flex flex-wrap items-center justify-between gap-4 overflow-hidden">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted">{delivered ? "Amount delivered" : delivery.status === "reversed" ? "Amount reversed" : delivery.status === "failed" ? "Amount not delivered" : delivery.status === "queued" ? "Amount queued" : "Amount in flight"}</div>
                  <div className="mt-2 text-[40px] sm:text-[48px] leading-none tabular-nums tracking-tight">
                    {usdCents(delivery.amountUsdc)} <span className="text-[16px] text-usdc">USDC</span>
                  </div>
                </div>
                {delivered && v.ok && v.anchorTxSig ? (
                  <Stamp animate className="text-[18px] sm:text-[22px] shrink-0 mr-2 text-verify! border-verify!">
                    <CheckGlyph /> Verified
                  </Stamp>
                ) : delivered && v.ok ? (
                  <Stamp animate className="text-[18px] sm:text-[22px] shrink-0 mr-2">
                    Delivered
                  </Stamp>
                ) : delivered ? (
                  <Stamp animate className="text-[18px] sm:text-[22px] shrink-0 mr-2">
                    Unverified
                  </Stamp>
                ) : (
                  <span className="hairline rounded-sm px-3 py-2 text-[12px] uppercase tracking-[0.18em] text-muted shrink-0">{state}</span>
                )}
              </div>

              {/* body */}
              <div className="mt-2">
                {failure ? (
                  <Line label="Reason">
                    <span className="font-sans">{failure}</span>
                    {delivery.status === "failed" && delivery.fundingTxSig ? (
                      <div className="mt-1 text-[12px]">
                        <ExternalLink href={solscanTx(delivery.fundingTxSig)}>Funding tx {short(delivery.fundingTxSig, 10, 10)}</ExternalLink>
                      </div>
                    ) : null}
                    {delivery.fundingRecoveryTxSig ? (
                      <div className="mt-1 text-[12px]">
                        <ExternalLink href={solscanTx(delivery.fundingRecoveryTxSig)}>Return tx {short(delivery.fundingRecoveryTxSig, 10, 10)}</ExternalLink>
                      </div>
                    ) : null}
                  </Line>
                ) : null}
                <Line label="To">
                  <Link href={`/c/${cause.slug}`} className="hit underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                    {cause.title}
                  </Link>
                  <div className="mt-1 text-[12px] text-muted">
                    {cause.beneficiary} · {PLATFORM_LABEL[cause.platform]}
                  </div>
                </Line>

                <Line label="From">
                  <Link href={`/v/${vault.slug}`} className="hit underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                    {vault.name}
                  </Link>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {allocations.map((a) => (
                      <li key={a.tokenId} className="flex items-center gap-2 text-[13px] tabular-nums">
                        <TokenMark symbol={a.token.symbol} imageUrl={a.token.imageUrl} size={16} />
                        <span className="w-20">${a.token.symbol}</span>
                        <span className="flex-1 rule-dashed h-px" aria-hidden />
                        <span>{usdCents(a.amountUsdc)}</span>
                        <span className="w-10 text-right text-muted">{((a.amountUsdc / delivery.amountUsdc) * 100).toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                </Line>

                <Line label="Amount">
                  <div className="tabular-nums">{usdCents(delivery.amountUsdc)} USDC</div>
                  {delivery.amountFiat !== null ? (
                    <div className="mt-1 text-[12px] text-muted tabular-nums">
                      {fiatDiffers ? `${delivery.amountFiat.toFixed(2)} ${delivery.fiatCurrency ?? ""} at ${delivery.fxRate ?? 1} ` : `${usdCents(delivery.amountFiat)} delivered in fiat`}
                      {delivery.platformFeeFiat !== null ? ` · platform fee ${delivery.platformFeeFiat.toFixed(2)} ${delivery.fiatCurrency ?? "USD"}` : ""}
                    </div>
                  ) : (
                    <div className="mt-1 text-[12px] text-muted">Fiat amount recorded at finalization.</div>
                  )}
                </Line>

                <Line label="Rail">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={delivery.rail === "onchain" ? "usdc" : "ink"}>{RAIL_LABEL[delivery.rail]}</Pill>
                    <span className="text-[13px]">{railText}</span>
                  </div>
                  {delivery.rail === "onchain" && delivery.railRef ? (
                    <div className="mt-1 text-[12px]">
                      <ExternalLink href={solscanTx(delivery.railRef)}>{short(delivery.railRef, 10, 10)}</ExternalLink>
                    </div>
                  ) : null}
                  {delivery.notes ? <div className="mt-1 text-[12px] text-muted font-sans">{delivery.notes}</div> : null}
                </Line>

                <Line label="Funding tx">
                  {delivery.fundingTxSig ? (
                    <span className="inline-flex items-center gap-2">
                      <ExternalLink href={solscanTx(delivery.fundingTxSig)} className="tabular-nums">
                        {short(delivery.fundingTxSig, 10, 10)}
                      </ExternalLink>
                      <CopyButton value={delivery.fundingTxSig} />
                    </span>
                  ) : (
                    <span className="text-muted">Not yet funded from treasury.</span>
                  )}
                  {delivery.fundedAt ? <div className="mt-1 text-[12px] text-muted">{dateTime(delivery.fundedAt)}</div> : null}
                </Line>

                <Line label="Evidence">
                  {artifacts.length === 0 ? (
                    <span className="text-muted">{delivered ? "No artifacts attached." : "Attached by the operator at delivery."}</span>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {artifacts.map((a) => (
                        <li key={a.id} className="flex items-start gap-2.5">
                          <ArtifactGlyph kind={a.kind} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                              <ExternalLink href={a.url}>{a.label}</ExternalLink>
                              <span className="text-[11px] text-muted uppercase tracking-[0.12em]">{ARTIFACT_LABEL[a.kind]}</span>
                              {a.bytes > 0 ? <span className="text-[11px] text-muted">{(a.bytes / 1024).toFixed(0)} KB</span> : null}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted tabular-nums">
                              sha256 {short(a.sha256, 10, 8)}
                              <CopyButton value={a.sha256} />
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Line>

                <Line label="Proof">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Receipt hash (sha256 of canonical JSON)</div>
                  <div className="mt-1 break-all text-[12px] tabular-nums leading-relaxed">
                    {v.computedHash}
                    <CopyButton value={v.computedHash} className="ml-2" />
                  </div>
                  {v.anchoredHash && v.anchoredHash !== v.computedHash ? (
                    <div className="mt-2">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Recorded hash</div>
                      <div className="mt-1 break-all text-[12px] tabular-nums leading-relaxed text-stamp">{v.anchoredHash}</div>
                    </div>
                  ) : null}
                  <div className="mt-3 text-[11px] uppercase tracking-[0.18em] text-muted">Anchor</div>
                  <div className="mt-1 text-[12px]">
                    {v.anchorTxSig ? (
                      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ExternalLink href={solscanTx(v.anchorTxSig)} className="tabular-nums">
                          {short(v.anchorTxSig, 10, 10)}
                        </ExternalLink>
                        <span className="text-muted">
                          memo {MEMO_PREFIX}
                          {short(delivery.id, 6, 4)}:…
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">Not anchored yet.</span>
                    )}
                  </div>
                  <div className={cx("mt-3 flex items-start gap-2 text-[13px]", v.ok && v.anchorTxSig ? "text-verify" : "text-ink-2")}>
                    {v.ok && v.anchorTxSig ? <CheckGlyph className="mt-1" /> : null}
                    <span className="font-sans">{v.ok && v.anchorTxSig ? "Recomputed hash matches the on-chain memo." : reason}</span>
                  </div>
                </Line>

                <Line label="Period">
                  {period ? (
                    <span>
                      {period.label} · {dateShort(period.startsAt)} – {dateShort(period.endsAt)}
                    </span>
                  ) : (
                    <span className="text-muted">Not assigned.</span>
                  )}
                </Line>

                <Line label="Delivery id" className="bg-none!">
                  <span className="inline-flex items-center gap-2 text-[12px] tabular-nums">
                    {delivery.id}
                    <CopyButton value={delivery.id} />
                  </span>
                </Line>
              </div>

              {/* footer */}
              <footer className="mt-8 hairline-t pt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="text-[12px] text-muted">
                  Recompute: see{" "}
                  <Link href="/docs#verify" className="hit underline underline-offset-4 hover:text-ink">
                    /docs#verify
                  </Link>
                  <span className="mx-2">·</span>
                  <a href={`/api/receipts/${delivery.id}/verify`} className="hit underline underline-offset-4 hover:text-ink">
                    verify.json
                  </a>
                </div>
                <ReceiptDownload canonical={canonical} filename={`${no}.canonical.json`} />
              </footer>
            </ReceiptPaper>

            <Eyebrow className="mt-5 text-center">Every dollar has a receipt.</Eyebrow>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
