import type { Metadata } from "next";
import { Suspense } from "react";
import { Header, Footer } from "@/components/shell";
import { Container, Eyebrow } from "@/components/ui";
import { ConnectWizard } from "@/components/app/ConnectWizard";
import { getSession } from "@/lib/auth/session";
import { listCauses, listVaults } from "@/lib/db/queries";
import { listVaultsByOwner } from "@/lib/db/queries.app";

export const metadata: Metadata = { title: "Connect a fundraiser", description: "Link a fundraiser, create a vault, route a token's creator fees. Three steps." };

export default async function ConnectPage() {
  const [session, causes] = await Promise.all([getSession(), listCauses()]);
  // Operators act on any vault (the API allows it); everyone else picks from their own. Both uncapped.
  const vaultRows = session ? (session.user.role === "user" ? (await listVaultsByOwner(session.user.id)).map((o) => o.vault) : (await listVaults()).map((c) => c.vault)) : [];

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24">
          <div className="max-w-[60ch]">
            <Eyebrow>Connect</Eyebrow>
            <h1 className="mt-3 font-display text-[44px] sm:text-[56px] leading-[0.95] tracking-tight text-balance">
              Any fundraiser. <span className="italic">Any token.</span> One route.
            </h1>
            <p className="mt-4 text-[15px] text-ink-2">Fundraiser, vault, token. When you finish, creator fees flow to a locked address and every delivery gets a receipt.</p>
          </div>
          <div className="mt-12">
            <Suspense fallback={<div className="font-mono text-[12px] text-muted">Loading…</div>}>
              <ConnectWizard
                causes={causes.map((c) => ({ id: c.id, slug: c.slug, title: c.title, platform: c.platform, verificationStatus: c.verificationStatus }))}
                vaults={vaultRows.map((v) => ({ id: v.id, slug: v.slug, name: v.name, causeId: v.causeId, treasuryAddress: v.treasuryAddress, deliveryThresholdUsd: v.deliveryThresholdUsd, donateBps: v.donateBps }))}
              />
            </Suspense>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
