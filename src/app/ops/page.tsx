import type { Metadata } from "next";
import { Header, Footer } from "@/components/shell";
import { Container, Eyebrow } from "@/components/ui";
import { SectionHead, Stat } from "@/components/app";
import { CauseVerifyPanel } from "@/components/app/CauseVerifyPanel";
import { OpsDesk } from "@/components/app/OpsDesk";
import { requireSession } from "@/lib/auth/session";
import { listCausesAwaitingVerification, listVaults } from "@/lib/db/queries";
import { listOpenDeliveries, listSettledDeliveries } from "@/lib/db/queries.app";
import { count, usd } from "@/lib/format";
import { zentroStatus } from "@/lib/zentro/session-store";

export const metadata: Metadata = { title: "Operator desk", robots: { index: false } };

export default async function OpsPage() {
  const { user } = await requireSession("operator");
  // Every vault queueDelivery accepts: active, with a verified cause.
  const [open, settled, cards, zentro, awaiting] = await Promise.all([listOpenDeliveries(), listSettledDeliveries(), listVaults({ status: "active", verified: true }), zentroStatus({ probe: false }), listCausesAwaitingVerification()]);
  const inFlight = open.reduce((s, d) => s + d.delivery.amountUsdc, 0);
  const awaitingFunding = open.filter((d) => d.delivery.status === "queued" || d.delivery.status === "funding").length;
  const awaitingExecution = open.filter((d) => d.delivery.status === "funded" || d.delivery.status === "executing").length;

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24" wide>
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Eyebrow>Operator desk</Eyebrow>
              <h1 className="mt-3 font-display text-[40px] sm:text-[52px] leading-[0.95] tracking-tight">Deliveries waiting on you.</h1>
              <p className="mt-3 text-[14px] text-muted">Signed in as {user.name ?? user.email} · {user.role}</p>
            </div>
            <div className="grid grid-cols-3 divide-x divide-line hairline rounded-lg px-4">
              <Stat label="In flight" value={usd(inFlight)} className="pr-4" />
              <Stat label="To fund" value={count(awaitingFunding)} className="px-4" />
              <Stat label="To execute" value={count(awaitingExecution)} className="pl-4" />
            </div>
          </div>
          <div className="mt-12">
            <OpsDesk
              open={open}
              settled={settled}
              vaults={cards.map((c) => ({ id: c.vault.id, slug: c.vault.slug, name: c.vault.name, causeTitle: c.cause.title, treasuryAddress: c.vault.treasuryAddress, deliveryThresholdUsd: c.vault.deliveryThresholdUsd, donateBps: c.vault.donateBps, feesUsd: c.totals.feesUsd, deliveredUsd: c.totals.deliveredUsd, pendingUsd: c.totals.pendingUsd, strandedUsd: c.totals.strandedUsd }))}
              zentro={{ sessionStored: zentro.sessionStored, canRelogin: zentro.canRelogin, last4: zentro.last4, lastOkAt: zentro.lastOkAt?.toISOString() ?? null, lastError: zentro.lastError }}
              operatorName={user.name ?? user.email ?? "operator"}
            />
          </div>
          <section className="mt-16">
            <SectionHead title="Fundraisers awaiting verification" aside={awaiting.length ? `${awaiting.length} to decide` : "queue empty"} />
            {awaiting.length === 0 ? (
              <p className="text-[13px] text-muted">Every submitted fundraiser has a decision on record.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {awaiting.map((c) => (
                  <CauseVerifyPanel key={c.id} cause={{ id: c.id, slug: c.slug, title: c.title, beneficiary: c.beneficiary, platform: c.platform, url: c.url, goalUsd: c.goalUsd, location: c.location, verificationStatus: c.verificationStatus, verificationNote: c.verificationNote, createdAt: c.createdAt }} />
                ))}
              </div>
            )}
          </section>
        </Container>
      </main>
      <Footer />
    </>
  );
}
