import type { Metadata } from "next";
import { Header, Footer } from "@/components/shell";
import { Container, Eyebrow } from "@/components/ui";
import { LaunchForm } from "@/components/app/LaunchForm";
import { getSession } from "@/lib/auth/session";
import { listCauses, listVaults } from "@/lib/db/queries";
import { listVaultsByOwner } from "@/lib/db/queries.app";

export const metadata: Metadata = { title: "Launch a token", description: "Launch on pump.fun with the fundraiser's vault as the creator wallet, so every creator fee routes there from the first trade." };

export default async function LaunchPage() {
  const [session, causes] = await Promise.all([getSession(), listCauses()]);
  // Operators act on any vault (the API allows it); everyone else picks from their own. Both uncapped.
  const vaultRows = session ? (session.user.role === "user" ? (await listVaultsByOwner(session.user.id)).map((o) => o.vault) : (await listVaults()).map((c) => c.vault)) : [];
  const launchReady = !!process.env.FEE_ROUTER_KMS_KEY && !!process.env.SOLANA_RPC_URL;

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24">
          <div className="max-w-[60ch]">
            <Eyebrow>Launch · pump.fun</Eyebrow>
            <h1 className="mt-3 font-display text-[44px] sm:text-[56px] leading-[0.95] tracking-tight text-balance">
              Launch with the route <span className="italic">already locked.</span>
            </h1>
            <p className="mt-4 text-[15px] text-ink-2">The vault&apos;s route address is the token&apos;s creator on pump.fun. Creator fees accrue to it from the first trade, and pump.fun cannot redirect them afterwards. No fee-share config, no redirect step.</p>
            {!launchReady ? <p className="mt-3 font-mono text-[12px] text-stamp">FEE_ROUTER_KMS_KEY or SOLANA_RPC_URL is not set on this server. The form submits, and the API will answer &ldquo;KMS not configured&rdquo; or &ldquo;RPC not configured&rdquo;.</p> : null}
          </div>
          <div className="mt-12">
            <LaunchForm causes={causes.map((c) => ({ id: c.id, slug: c.slug, title: c.title, platform: c.platform }))} vaults={vaultRows.map((v) => ({ id: v.id, slug: v.slug, name: v.name, causeId: v.causeId }))} />
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
