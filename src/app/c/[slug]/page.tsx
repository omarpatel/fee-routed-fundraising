import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header, Footer } from "@/components/shell";
import { ButtonLink, Container, Eyebrow, Panel, Row, StatusPill } from "@/components/ui";
import { CATEGORY_LABEL, CheckGlyph, DeliveryRow, ExternalLink, PLATFORM_LABEL, PlatformPill, ProgressBar, ReceiptPaper, SectionHead, Stat } from "@/components/app";
import { VaultCard } from "@/components/app/VaultCard";
import { getCauseBySlug, listVaults } from "@/lib/db/queries";
import { listDeliveriesByCause } from "@/lib/db/queries.app";
import { count, dateShort, receiptNo, solscanAddr, usd, usdCents } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const c = await getCauseBySlug((await params).slug);
  if (!c) return { title: "Cause not found" };
  return { title: c.title, description: c.summary, openGraph: c.imageUrl ? { images: [c.imageUrl] } : undefined };
}

export default async function CausePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cause = await getCauseBySlug(slug);
  if (!cause) notFound();
  const [vaults, deliveries] = await Promise.all([listVaults({ causeId: cause.id }), listDeliveriesByCause(cause.id)]);
  const createVaultHref = `/connect?step=vault&cause=${encodeURIComponent(cause.id)}`;
  const delivered = deliveries.filter((d) => d.delivery.status === "delivered");
  const deliveredUsd = delivered.reduce((s, d) => s + d.delivery.amountUsdc, 0);
  const goal = cause.goalUsd ?? 0;
  const raised = deliveredUsd + (cause.raisedExternalUsd ?? 0);

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24">
          <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
            <article>
              <div className="flex flex-wrap items-center gap-2">
                <Eyebrow>Cause · {CATEGORY_LABEL[cause.category] ?? cause.category}</Eyebrow>
                <PlatformPill platform={cause.platform} />
                <StatusPill status={cause.verificationStatus} />
              </div>
              <h1 className="mt-3 font-display text-[40px] sm:text-[56px] leading-[0.95] tracking-tight text-balance">{cause.title}</h1>
              <p className="mt-4 font-display italic text-[22px] text-ink-2">{cause.summary}</p>
              {cause.location ? <p className="mt-2 font-mono text-[12px] text-muted uppercase tracking-[0.12em]">{cause.location}</p> : null}

              <div className="mt-8 relative aspect-[16/9] bg-paper-2 rounded-lg overflow-hidden hairline">
                {cause.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cause.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : null}
              </div>

              <SectionHead title="Story" className="mt-12" />
              <div className="max-w-[62ch] text-[16px] leading-[1.6] text-ink-2 whitespace-pre-line">{cause.story}</div>

              <SectionHead title="Verification" className="mt-12" id="verification" />
              <Panel className="p-5">
                <div className="flex items-center gap-3">
                  {cause.verificationStatus === "verified" ? (
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border-2 border-verify text-verify">
                      <CheckGlyph />
                    </span>
                  ) : null}
                  <div>
                    <div className="font-mono text-[13px] uppercase tracking-[0.12em]">{cause.verificationStatus}</div>
                    <div className="text-[12px] text-muted">
                      {cause.verificationStatus === "verified" && cause.verifiedAt ? `Verified ${dateShort(cause.verifiedAt)}` : cause.verificationStatus === "pending" ? "Under review by Fee Router operations" : cause.verificationStatus === "rejected" ? "Not eligible for deliveries" : "Not yet reviewed"}
                    </div>
                  </div>
                </div>
                {cause.verificationNote ? <p className="mt-4 text-[14px] text-ink-2 hairline-t pt-4">{cause.verificationNote}</p> : null}
                <div className="mt-4 hairline-t pt-1">
                  <Row label="Beneficiary" value={<span className="font-sans">{cause.beneficiary}</span>} />
                  <Row label="Platform" value={PLATFORM_LABEL[cause.platform]} />
                  <Row label="Fundraiser" value={<ExternalLink href={cause.url}>{cause.url.replace(/^https?:\/\//, "")}</ExternalLink>} />
                  {cause.onchainAddress ? <Row label="USDC recipient" value={<ExternalLink href={solscanAddr(cause.onchainAddress)}>{cause.onchainAddress}</ExternalLink>} /> : null}
                  <Row label="Listed" value={dateShort(cause.createdAt)} />
                </div>
              </Panel>

              <SectionHead title="Vaults funding this cause" aside={`${count(vaults.length)} vault${vaults.length === 1 ? "" : "s"}`} className="mt-12" id="vaults" />
              {vaults.length === 0 ? (
                <div className="hairline rounded-lg p-8 text-center">
                  <p className="font-display text-[24px]">No vault yet.</p>
                  <p className="mt-2 text-[14px] text-muted">Create one and point a token at this fundraiser.</p>
                  <ButtonLink href={createVaultHref} variant="stamp" className="mt-5">
                    Create a vault
                  </ButtonLink>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {vaults.map((v) => (
                    <VaultCard key={v.vault.id} v={v} />
                  ))}
                </div>
              )}

              <SectionHead title="Deliveries" aside={`${count(delivered.length)} receipted · ${usdCents(deliveredUsd)}`} className="mt-12" id="deliveries" />
              <ReceiptPaper>
                {deliveries.length === 0 ? (
                  <p className="py-6 text-[14px] text-muted text-center">Nothing delivered yet.</p>
                ) : (
                  deliveries.map((d) => <DeliveryRow key={d.delivery.id} d={d} receiptNo={receiptNo(d.delivery.ordinal)} vaultLabel={d.vault.name} />)
                )}
              </ReceiptPaper>
            </article>

            <aside className="lg:sticky lg:top-24 self-start flex flex-col gap-4">
              <Panel className="p-5">
                <Stat label="Delivered by Fee Router" value={usd(deliveredUsd)} sub={`${count(delivered.length)} receipt${delivered.length === 1 ? "" : "s"}`} className="py-0" />
                {goal > 0 ? (
                  <div className="mt-5">
                    <ProgressBar value={raised / goal} tone="verify" />
                    <div className="mt-2 flex justify-between font-mono text-[11px] text-muted tabular-nums">
                      <span>{usd(raised)} raised</span>
                      <span>{Math.round((raised / goal) * 100)}% of {usd(goal)}</span>
                    </div>
                    <p className="mt-3 text-[12px] text-muted">Raised = Fee Router deliveries + {usd(cause.raisedExternalUsd ?? 0)} raised elsewhere on {PLATFORM_LABEL[cause.platform]}.</p>
                  </div>
                ) : null}
                <div className="mt-5 flex flex-col gap-2">
                  <a href={cause.url} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-sm h-10 px-4 text-[13px] font-medium bg-ink text-paper hover:bg-ink-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
                    Open on {PLATFORM_LABEL[cause.platform]}
                  </a>
                  <ButtonLink href={vaults.length ? `/v/${vaults[0].vault.slug}` : createVaultHref} variant="ghost">
                    {vaults.length ? "Open the vault" : "Create a vault"}
                  </ButtonLink>
                </div>
              </Panel>
              <p className="text-[12px] text-muted px-1">
                Every delivery has a receipt with a hash anchored on Solana.{" "}
                <Link href="/docs#verify" className="hit underline underline-offset-4">
                  How to verify
                </Link>
              </p>
            </aside>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
