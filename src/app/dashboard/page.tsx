import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { Header, Footer } from "@/components/shell";
import { ButtonLink, Container, Eyebrow, Panel, Pill, Row, StatusPill, TokenMark } from "@/components/ui";
import { ExternalLink, PlatformPill, RouteLockPill, SectionHead, SourcePill } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import { WalletCard } from "@/components/app/WalletCard";
import { requireSession } from "@/lib/auth/session";
import { listVaults } from "@/lib/db/queries";
import { listVaultsByOwner } from "@/lib/db/queries.app";
import { bps, count, dateShort, short, solscanAddr, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard", description: "Your vaults, tokens and wallet on Fee Router.", robots: { index: false } };

export default async function DashboardPage() {
  const { user } = await requireSession();
  const [owned, cards, qrSvg] = await Promise.all([listVaultsByOwner(user.id), listVaults({ ownerUserId: user.id }), QRCode.toString(user.walletAddress, { type: "svg", margin: 0, color: { dark: "#101010", light: "#0000" } })]);
  const totals = new Map(cards.map((c) => [c.vault.id, c.totals]));
  const tokens = owned.flatMap((o) => o.tokens.map((t) => ({ token: t, vault: o.vault })));

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Eyebrow>Dashboard</Eyebrow>
              <h1 className="mt-3 font-display text-[40px] sm:text-[52px] leading-[0.95] tracking-tight">{user.name ?? user.email ?? "Your account"}</h1>
              <p className="mt-3 text-[14px] text-muted">
                {count(owned.length)} vault{owned.length === 1 ? "" : "s"} · {count(tokens.length)} token{tokens.length === 1 ? "" : "s"}
                {user.role !== "user" ? (
                  <>
                    {" "}
                    ·{" "}
                    <Link href="/ops" className="underline underline-offset-4">
                      Operator desk
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex gap-2">
              <ButtonLink href="/connect" variant="ink">
                Connect a fundraiser
              </ButtonLink>
              <ButtonLink href="/launch" variant="ghost">
                Launch a token
              </ButtonLink>
            </div>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_340px]">
            <div>
              <SectionHead title="My vaults" aside={`${count(owned.length)}`} />
              {owned.length === 0 ? (
                <Panel className="p-8 text-center">
                  <p className="font-display text-[26px]">No vaults yet.</p>
                  <p className="mt-2 text-[14px] text-muted max-w-[44ch] mx-auto">A vault points token revenue at one fundraiser. Connect a fundraiser first, then a token.</p>
                  <div className="mt-5 flex justify-center gap-2">
                    <ButtonLink href="/connect" variant="stamp">
                      Connect a fundraiser
                    </ButtonLink>
                    <ButtonLink href="/explore" variant="ghost">
                      See live vaults
                    </ButtonLink>
                  </div>
                </Panel>
              ) : (
                <div className="flex flex-col gap-4">
                  {owned.map(({ vault, cause, tokens: vtoks }) => {
                    const t = totals.get(vault.id);
                    return (
                      <Panel key={vault.id} className="p-5" as="article">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <Link href={`/v/${vault.slug}`} className="font-display text-[24px] leading-none hover:underline underline-offset-4">
                              {vault.name}
                            </Link>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                              <StatusPill status={vault.status} />
                              <PlatformPill platform={cause.platform} />
                              <Link href={`/c/${cause.slug}`} className="underline underline-offset-4 hover:text-ink">
                                {cause.title}
                              </Link>
                            </div>
                          </div>
                          <ButtonLink href={`/connect?step=token&vault=${vault.slug}`} variant="ghost" size="sm">
                            Connect a token
                          </ButtonLink>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-3 hairline-t pt-4">
                          <div>
                            <Eyebrow>Fees routed</Eyebrow>
                            <div className="mt-1 font-mono text-[18px] tabular-nums">{usd(t?.feesUsd ?? 0)}</div>
                          </div>
                          <div>
                            <Eyebrow>Delivered</Eyebrow>
                            <div className="mt-1 font-mono text-[18px] tabular-nums">{usd(t?.deliveredUsd ?? 0)}</div>
                          </div>
                          <div>
                            <Eyebrow>Pending</Eyebrow>
                            <div className="mt-1 font-mono text-[18px] tabular-nums">{usd(t?.pendingUsd ?? 0)}</div>
                          </div>
                        </div>
                        <div className="mt-4 hairline-t pt-1">
                          <Row label="Treasury" value={<span className="inline-flex items-center gap-2"><ExternalLink href={solscanAddr(vault.treasuryAddress)}>{short(vault.treasuryAddress, 6, 6)}</ExternalLink><CopyButton value={vault.treasuryAddress} /></span>} />
                          <Row label="Donates" value={`${bps(vault.donateBps)} · delivers at ${usd(vault.deliveryThresholdUsd)}`} />
                          <Row label="Tokens" value={vtoks.length === 0 ? <span className="text-muted">none connected</span> : vtoks.map((x) => `$${x.symbol}`).join(" · ")} />
                        </div>
                      </Panel>
                    );
                  })}
                </div>
              )}

              <SectionHead title="My tokens" aside={`${count(tokens.length)}`} className="mt-12" />
              {tokens.length === 0 ? (
                <Panel className="p-8 text-center">
                  <p className="font-display text-[26px]">No tokens connected.</p>
                  <p className="mt-2 text-[14px] text-muted max-w-[44ch] mx-auto">Point an existing token&apos;s creator fees at a vault, or launch a new one with fees routed from day one.</p>
                  <div className="mt-5 flex justify-center gap-2">
                    <ButtonLink href={owned.length ? `/connect?step=token&vault=${owned[0].vault.slug}` : "/connect"} variant="ink">
                      Connect a token
                    </ButtonLink>
                    <ButtonLink href="/launch" variant="ghost">
                      Launch on pump.fun
                    </ButtonLink>
                  </div>
                </Panel>
              ) : (
                <div className="flex flex-col">
                  {tokens.map(({ token, vault }) => (
                    <div key={token.id} className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-4 gap-y-2 py-3 rule-dashed">
                      <TokenMark symbol={token.symbol} imageUrl={token.imageUrl} size={28} />
                      <div className="min-w-0">
                        <div className="font-mono text-[13px]">
                          ${token.symbol} <span className="text-muted">{token.name}</span>
                        </div>
                        <div className="text-[11px] text-muted truncate">
                          route <ExternalLink href={solscanAddr(token.routeAddress)}>{short(token.routeAddress, 6, 6)}</ExternalLink> → {vault.name} · {bps(token.routeBps)} · connected {dateShort(token.createdAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <SourcePill source={token.source} />
                        {token.launchedViaFeeRouter ? <Pill tone="ink">via fee router</Pill> : null}
                      </div>
                      <RouteLockPill locked={token.routeLocked} proofTx={token.routeProofTx} />
                      <Link href={`/v/${vault.slug}#attribution`} className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted hover:text-ink">
                        vault →
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <aside className="flex flex-col gap-4">
              <WalletCard address={user.walletAddress} qrSvg={qrSvg} />
              <Panel className="p-5">
                <Eyebrow>Account</Eyebrow>
                <div className="mt-1">
                  <Row label="Email" value={<span className="font-sans">{user.email ?? "—"}</span>} />
                  <Row label="Role" value={user.role} />
                  <Row label="Member since" value={dateShort(user.createdAt)} />
                </div>
              </Panel>
            </aside>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
