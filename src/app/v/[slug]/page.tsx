import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header, Footer } from "@/components/shell";
import { ButtonLink, Container, Eyebrow, Panel, Pill, Row, StatusPill, TokenMark } from "@/components/ui";
import { AllocationChips, CheckGlyph, DeliveryRow, ExternalLink, PlatformPill, ProgressBar, RailPill, ReceiptPaper, RouteLockPill, SectionHead, SourcePill, Stat } from "@/components/app";
import { CopyButton, ShareButton } from "@/components/app/CopyButton";
import { Sparkline } from "@/components/app/Sparkline";
import { feeSeries, getVaultBySlug, type DeliveryWithAllocations } from "@/lib/db/queries";
import { getSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { bps, count, dateShort, dateTime, rawToUi, receiptNo, short, solscanAddr, solscanTx, timeAgo, usd, usdCents } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const v = await getVaultBySlug((await params).slug);
  if (!v) return { title: "Vault not found" };
  return { title: v.vault.name, description: `${usd(v.totals.deliveredUsd)} delivered to ${v.cause.title}. ${count(v.totals.deliveryCount)} receipts.` };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

export default async function VaultPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [v, session] = await Promise.all([getVaultBySlug(slug), getSession()]);
  if (!v) notFound();
  const { vault, cause, totals, tokens, periods, deliveries, recentFees } = v;

  // One query for every period's daily buckets (periods are whole UTC days, newest first), not one per period.
  const days = periods.length ? await feeSeries(vault.id, periods[periods.length - 1].startsAt, periods[0].endsAt) : [];
  const series = periods.map((p) => {
    const from = p.startsAt.toISOString().slice(0, 10);
    const to = p.endsAt.toISOString().slice(0, 10);
    return days.filter((d) => d.day >= from && d.day < to);
  });
  const isOwner = !!session && (session.user.id === vault.ownerUserId || session.user.role !== "user");
  const goal = cause.goalUsd ?? 0;
  const raised = totals.causeDeliveredUsd + (cause.raisedExternalUsd ?? 0);
  const feesSum = tokens.reduce((s, t) => s + t.feesUsd, 0);

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24">
          {/* ---------- top ---------- */}
          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Eyebrow>Vault</Eyebrow>
                <StatusPill status={vault.status} />
                <PlatformPill platform={cause.platform} />
              </div>
              <h1 className="mt-3 font-display text-[44px] sm:text-[60px] leading-[0.95] tracking-tight">{vault.name}</h1>
              {vault.tagline ? <p className="mt-3 font-display italic text-[22px] text-ink-2">{vault.tagline}</p> : null}
              <p className="mt-4 text-[15px] text-ink-2">
                Funds{" "}
                <Link href={`/c/${cause.slug}`} className="hit underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  {cause.title}
                </Link>
                {cause.location ? <span className="text-muted"> · {cause.location}</span> : null}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px]">
                <span className="text-muted">Treasury</span>
                <ExternalLink href={solscanAddr(vault.treasuryAddress)} className="tabular-nums">
                  {vault.treasuryAddress}
                </ExternalLink>
                <span className="text-muted">USDC · donates {bps(vault.donateBps)} · delivers at {usd(vault.deliveryThresholdUsd)}</span>
              </div>

              <div className="mt-8 grid grid-cols-1 hairline-t hairline-b divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <Stat label="Fees routed" value={usd(totals.feesUsd)} sub={`${count(totals.tokenCount)} token${totals.tokenCount === 1 ? "" : "s"}`} className="py-4 sm:py-0 sm:pr-4" />
                <Stat label="Delivered" value={usd(totals.deliveredUsd)} sub={`${count(totals.deliveryCount)} receipt${totals.deliveryCount === 1 ? "" : "s"}`} className="py-4 sm:py-0 sm:px-4" />
                <Stat
                  label="Pending"
                  value={usd(totals.pendingUsd)}
                  sub={
                    <>
                      {totals.pendingUsd > 0 ? "queued or funded, not yet delivered" : "nothing in flight"}
                      {totals.strandedUsd > 0 ? <span className="block text-stamp">{usdCents(totals.strandedUsd)} stranded, awaiting operator</span> : null}
                    </>
                  }
                  className="py-4 sm:py-0 sm:pl-4"
                />
              </div>
            </div>

            {/* ---------- sidebar ---------- */}
            <aside className="flex flex-col gap-4">
              <Panel className="overflow-hidden" as="section">
                <div className="aspect-[16/9] bg-paper-2 relative">
                  {cause.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cause.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="p-4">
                  <Eyebrow>Cause</Eyebrow>
                  <Link href={`/c/${cause.slug}`} className="hit mt-1 block font-display text-[20px] leading-tight hover:underline underline-offset-4">
                    {cause.title}
                  </Link>
                  <p className="mt-2 text-[13px] text-ink-2">{cause.summary}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusPill status={cause.verificationStatus} />
                    <ExternalLink href={cause.url} className="font-mono text-[11px] uppercase tracking-[0.12em]">
                      Fundraiser page
                    </ExternalLink>
                  </div>
                  {goal > 0 ? (
                    <div className="mt-4">
                      <ProgressBar value={raised / goal} tone="verify" />
                      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted tabular-nums">
                        <span>{usd(raised)} raised</span>
                        <span>{usd(goal)} goal</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Panel>

              <div className="flex flex-col gap-2">
                {isOwner ? (
                  <ButtonLink href={`/connect?step=token&vault=${vault.slug}`} variant="ink">
                    Connect a token to this vault
                  </ButtonLink>
                ) : null}
                <ShareButton />
              </div>
            </aside>
          </div>

          {/* ---------- attribution ---------- */}
          <section className="mt-16">
            <SectionHead title="Attribution" aside={`${totals.tokenCount} token${totals.tokenCount === 1 ? "" : "s"} · fees ${usdCents(feesSum)}`} id="attribution" />
            <div className="overflow-x-auto -mx-5 sm:mx-0">
              <table className="w-full min-w-[820px] text-[13px]">
                <thead>
                  <tr className="text-left hairline-b">
                    <th className="py-2 pl-5 sm:pl-0 pr-3 font-normal">
                      <Eyebrow>Token</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal">
                      <Eyebrow>Source</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal">
                      <Eyebrow>Route</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal">
                      <Eyebrow>Lock</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal text-right">
                      <Eyebrow>Fees</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal text-right">
                      <Eyebrow>Delivered</Eyebrow>
                    </th>
                    <th className="py-2 pr-5 sm:pr-0 font-normal w-[180px]">
                      <Eyebrow>Share</Eyebrow>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map(({ token, feesUsd, deliveredUsd, eventCount, lastEventAt }) => {
                    const share = feesSum > 0 ? feesUsd / feesSum : 0;
                    return (
                      <tr key={token.id} className="rule-dashed align-middle">
                        <td className="py-3 pl-5 sm:pl-0 pr-3">
                          <div className="flex items-center gap-2.5">
                            <TokenMark symbol={token.symbol} imageUrl={token.imageUrl} size={28} />
                            <div>
                              <div className="font-mono text-[13px]">${token.symbol}</div>
                              <div className="text-[11px] text-muted">
                                {token.name}
                                {lastEventAt ? ` · ${count(eventCount)} events · last ${timeAgo(lastEventAt)}` : " · no fees yet"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="flex items-center gap-1.5">
                            <SourcePill source={token.source} />
                            {token.launchedViaFeeRouter ? <Pill tone="ink">via fee router</Pill> : null}
                            {token.supersededAt ? <Pill>superseded</Pill> : null}
                          </div>
                        </td>
                        <td className="py-3 pr-3 font-mono tabular-nums">
                          {bps(token.routeBps)}
                          <div className="text-[11px] text-muted">
                            <ExternalLink href={solscanAddr(token.routeAddress)}>{short(token.routeAddress, 6, 6)}</ExternalLink>
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <RouteLockPill locked={token.routeLocked} proofTx={token.routeProofTx} />
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums">{usdCents(feesUsd)}</td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums">{usdCents(deliveredUsd)}</td>
                        <td className="py-3 pr-5 sm:pr-0">
                          <div className="flex items-center gap-2">
                            <ProgressBar value={share} className="flex-1" />
                            <span className="font-mono text-[12px] tabular-nums w-12 text-right">{(share * 100).toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="hairline-t">
                    <td colSpan={4} className="py-3 pl-5 sm:pl-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                      Total
                    </td>
                    <td className="py-3 pr-3 text-right font-mono tabular-nums">{usdCents(feesSum)}</td>
                    <td className="py-3 pr-3 text-right font-mono tabular-nums">{usdCents(tokens.reduce((s, t) => s + t.deliveredUsd, 0))}</td>
                    <td className="py-3 pr-5 sm:pr-0 font-mono text-[12px] tabular-nums text-right">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ---------- periods ---------- */}
          <section className="mt-16">
            <SectionHead title="Periods" aside="weekly reporting windows" id="periods" />
            {periods.length === 0 ? (
              <p className="text-[14px] text-muted">No reporting periods yet.</p>
            ) : (
              <ol className="flex flex-col">
                {periods.map((p, i) => (
                  <li key={p.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[210px_1fr_120px_130px_120px_90px] items-center gap-x-4 gap-y-2 py-3.5 rule-dashed">
                    <div>
                      <div className="font-mono text-[13px]">{p.label}</div>
                      <div className="font-mono text-[11px] text-muted tabular-nums">
                        {dateShort(p.startsAt)} – {dateShort(p.endsAt)}
                      </div>
                    </div>
                    <Sparkline points={series[i].map((d) => d.usd)} className="text-ink justify-self-end sm:justify-self-start" />
                    <div className="col-span-2 sm:col-span-1 flex sm:block gap-4">
                      <Eyebrow className="sm:hidden">Fees in</Eyebrow>
                      <span className="font-mono text-[13px] tabular-nums">{usdCents(p.status === "closed" ? p.feesUsd : series[i].reduce((s, d) => s + d.usd, 0))}</span>
                    </div>
                    <div className="col-span-2 sm:col-span-1 flex sm:block gap-4">
                      <Eyebrow className="sm:hidden">Delivered</Eyebrow>
                      <span className="font-mono text-[13px] tabular-nums">{usdCents(p.deliveredUsd)}</span>
                    </div>
                    <div className="hidden sm:block font-mono text-[11px] text-muted tabular-nums">{series[i].length} active days</div>
                    <div className="col-span-2 sm:col-span-1">
                      <StatusPill status={p.status} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ---------- deliveries ---------- */}
          <section className="mt-16">
            <SectionHead title="Deliveries" aside={`${count(deliveries.length)} total · ${usdCents(totals.deliveredUsd)} delivered`} id="deliveries" />
            <ReceiptPaper>
              {deliveries.length === 0 ? (
                <p className="py-6 text-[14px] text-muted text-center">No deliveries yet. The first one queues once the treasury reaches {usd(vault.deliveryThresholdUsd)}.</p>
              ) : (
                deliveries.map((d) => <DeliveryRow key={d.delivery.id} d={d} receiptNo={receiptNo(d.delivery.ordinal)} />)
              )}
            </ReceiptPaper>
          </section>

          {/* ---------- fee events ---------- */}
          <section className="mt-16">
            <SectionHead title="Recent fee events" aside={`last ${recentFees.length} on-chain events`} id="fees" />
            <div className="overflow-x-auto -mx-5 sm:mx-0">
              <table className="w-full min-w-[640px] font-mono text-[12px] tabular-nums">
                <thead>
                  <tr className="text-left hairline-b">
                    <th className="py-2 pl-5 sm:pl-0 pr-3 font-normal">
                      <Eyebrow>Time</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal">
                      <Eyebrow>Token</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal">
                      <Eyebrow>Kind</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal text-right">
                      <Eyebrow>Asset</Eyebrow>
                    </th>
                    <th className="py-2 pr-3 font-normal text-right">
                      <Eyebrow>USD</Eyebrow>
                    </th>
                    <th className="py-2 pr-5 sm:pr-0 font-normal text-right">
                      <Eyebrow>Tx</Eyebrow>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentFees.map((f) => (
                    <tr key={f.id} className="rule-dashed">
                      <td className="py-2 pl-5 sm:pl-0 pr-3 text-muted whitespace-nowrap">{dateTime(f.blockTime)}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1.5">
                          <TokenMark symbol={f.token.symbol} imageUrl={f.token.imageUrl} size={16} />${f.token.symbol}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-muted">{f.kind.replace("_", " ")}</td>
                      <td className="py-2 pr-3 text-right">
                        {rawToUi(f.amountRaw, f.decimals).toLocaleString("en-US", { maximumFractionDigits: f.assetMint === SOL_MINT ? 4 : 2 })} {f.assetMint === SOL_MINT ? "SOL" : short(f.assetMint, 4, 3)}
                      </td>
                      <td className="py-2 pr-3 text-right">{usdCents(f.amountUsd)}</td>
                      <td className="py-2 pr-5 sm:pr-0 text-right">
                        <ExternalLink href={solscanTx(f.txSig)}>{short(f.txSig, 6, 6)}</ExternalLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tokens.some((t) => t.token.routeLocked) ? (
              <p className="mt-4 flex items-center gap-2 text-[12px] text-muted">
                <CheckGlyph className="text-verify" /> Locked routes are on-chain-immutable: fees cannot be redirected away from this vault.
              </p>
            ) : null}
          </section>

          {deliveries.length > 0 ? (
            <section className="mt-16">
              <SectionHead title="Latest receipt" id="latest" />
              <LatestReceipt d={deliveries[0]} slug={vault.slug} />
            </section>
          ) : null}

          <EmbedBadge slug={vault.slug} name={vault.name} />
        </Container>
      </main>
      <Footer />
    </>
  );
}

function EmbedBadge({ slug, name }: { slug: string; name: string }) {
  const site = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const page = `${site}/v/${slug}`;
  const img = `${page}/badge.svg`;
  const alt = `${name} on Fee Router`;
  const snippets = [
    { label: "HTML", value: `<a href="${page}"><img src="${img}" alt="${alt.replace(/"/g, "&quot;")}" height="20"></a>` },
    { label: "Markdown", value: `[![${alt.replace(/[[\]]/g, "")}](${img})](${page})` },
  ];
  return (
    <section className="mt-16">
      <SectionHead title="Embed" aside="live badge · refreshes every 5 minutes" id="embed" />
      <p className="max-w-[60ch] text-[14px] text-ink-2">Put this vault&apos;s running total on the fundraiser&apos;s website, a README or a link page. It links back here, where every dollar has a receipt.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/v/${slug}/badge.svg`} alt={alt} height={20} className="mt-5 h-5 w-auto" />
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {snippets.map((s) => (
          <div key={s.label} className="min-w-0">
            <div className="flex items-center justify-between">
              <Eyebrow>{s.label}</Eyebrow>
              <CopyButton value={s.value} label={`copy ${s.label.toLowerCase()}`} />
            </div>
            <pre className="mt-2 overflow-x-auto hairline rounded-sm bg-paper-2 p-3 font-mono text-[12px] leading-relaxed">
              <code>{s.value}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}

function LatestReceipt({ d, slug }: { d: DeliveryWithAllocations; slug: string }) {
  const { delivery } = d;
  return (
    <ReceiptPaper className="max-w-[560px]" inner="px-5 py-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[13px] tracking-wide">{receiptNo(delivery.ordinal)}</span>
        <RailPill rail={delivery.rail} />
      </div>
      <Row label="Amount" value={usdCents(delivery.amountUsdc) + " USDC"} />
      <Row label="Status" value={<StatusPill status={delivery.status} />} />
      <Row label={delivery.deliveredAt ? "Delivered" : "Queued"} value={dateTime(delivery.deliveredAt ?? delivery.queuedAt)} />
      <div className="py-3">
        <AllocationChips allocations={d.allocations} total={delivery.amountUsdc} />
      </div>
      <div className="flex items-center justify-between">
        <Link href={`/r/${delivery.id}`} className="hit font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
          Open receipt
        </Link>
        <a href={`/api/vaults/${slug}/receipts.json`} className="hit font-mono text-[11px] uppercase tracking-[0.12em] text-muted hover:text-ink">
          receipts.json
        </a>
      </div>
    </ReceiptPaper>
  );
}
