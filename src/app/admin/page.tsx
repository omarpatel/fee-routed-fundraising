import type { Metadata } from "next";
import Link from "next/link";
import { Header, Footer } from "@/components/shell";
import { Container, Eyebrow, Mono, Panel, Pill, Row } from "@/components/ui";
import { ExternalLink, SectionHead, Stat, ZentroPanel } from "@/components/app";
import { CreateTreasuryButton, LaunchProtocolForm, RegisterHeliusButton } from "@/components/app/AdminPanel";
import { CauseVerifyPanel } from "@/components/app/CauseVerifyPanel";
import { CopyButton } from "@/components/app/CopyButton";
import { requireSession } from "@/lib/auth/session";
import { listCausesAwaitingVerification } from "@/lib/db/queries";
import { configured } from "@/lib/env";
import { bps, count, dateTime, rawToUi, short, solscanAddr, solscanTx, timeAgo, usd, usdCents } from "@/lib/format";
import { COMMONS_VAULT_SLUG, PROTOCOL_SPLIT, listOperators, listProtocolFeeEvents, protocolStats } from "@/lib/protocol";
import { integrationStatuses } from "@/lib/protocol/integrations";
import { SOL_MINT, USDC_MINT } from "@/lib/solana/rpc";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };
export const dynamic = "force-dynamic";

const ASSET_LABEL: Record<string, string> = { [SOL_MINT]: "SOL", [USDC_MINT.toBase58()]: "USDC" };

export default async function AdminPage() {
  const { user } = await requireSession("admin");
  const [stats, integrations, operators, events, awaiting] = await Promise.all([protocolStats(), integrationStatuses(), listOperators(), listProtocolFeeEvents(12), listCausesAwaitingVerification()]);
  const helius = integrations.find((i) => i.key === "helius")!;
  const launchBlocked = [!configured.kms && "FEE_ROUTER_KMS_KEY is not configured", !configured.rpc && "SOLANA_RPC_URL is not configured"].filter((s): s is string => typeof s === "string");

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-10 pb-24" wide>
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Eyebrow>Admin</Eyebrow>
              <h1 className="mt-3 font-display text-[40px] sm:text-[52px] leading-[0.95] tracking-tight">Protocol.</h1>
              <p className="mt-3 text-[14px] text-muted">
                Signed in as {user.name ?? user.email} · {user.role} · wallet <Mono>{short(user.walletAddress, 6, 6)}</Mono>
              </p>
            </div>
            <div className="grid grid-cols-3 divide-x divide-line hairline rounded-lg px-4">
              <Stat label="Fees, all time" value={usd(stats.feesUsdAll)} className="pr-4" />
              <Stat label="Fees, 30d" value={usd(stats.feesUsd30d)} className="px-4" />
              <Stat label="Events" value={count(stats.eventCount)} className="pl-4" />
            </div>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_380px]">
            <div className="flex flex-col gap-12">
              <section>
                <SectionHead title="Protocol treasury" aside={stats.treasuryAddress ? "custodial · purpose protocol_treasury" : "not created"} />
                {stats.treasuryAddress ? (
                  <Panel className="p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <Mono className="break-all">{stats.treasuryAddress}</Mono>
                      <CopyButton value={stats.treasuryAddress} />
                      <ExternalLink href={solscanAddr(stats.treasuryAddress)} className="font-mono text-[12px]">
                        Solscan
                      </ExternalLink>
                    </div>
                    <div className="mt-4 grid gap-x-10 sm:grid-cols-2">
                      <div>
                        <Row label="SOL" value={stats.balances ? stats.balances.sol.toFixed(4) : <span className="text-muted">{stats.balancesError}</span>} />
                        <Row label="USDC" value={stats.balances ? usdCents(stats.balances.usdc) : <span className="text-muted">{stats.balancesError}</span>} />
                        <Row label="Forwarded to Commons" value={`${stats.commonsForwardedSol.toFixed(4)} SOL`} />
                        <Row label="Owed to Commons" value={`${stats.commonsOwedSol.toFixed(4)} SOL`} />
                      </div>
                      <div>
                        <Row label="Fees 7d" value={usdCents(stats.feesUsd7d)} />
                        <Row label="Fees 30d" value={usdCents(stats.feesUsd30d)} />
                        <Row label="Fees all time" value={usdCents(stats.feesUsdAll)} />
                        <Row label="Last inflow" value={stats.lastEventAt ? `${timeAgo(stats.lastEventAt)} · ${dateTime(stats.lastEventAt)}` : "none yet"} />
                      </div>
                    </div>
                    <div className="mt-5">
                      <Eyebrow>Recent inflows</Eyebrow>
                      {events.length === 0 ? (
                        <p className="mt-2 text-[13px] text-muted">No inflows recorded. Fee events appear here once the Helius webhook is registered and $ROUTE trades.</p>
                      ) : (
                        <div className="mt-2 flex flex-col">
                          {events.map((e) => (
                            <div key={e.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-2 rule-dashed font-mono text-[12px]">
                              <span className="truncate">
                                <ExternalLink href={solscanTx(e.txSig)}>{short(e.txSig, 8, 8)}</ExternalLink> <span className="text-muted">· {e.source ?? "transfer"}</span>
                              </span>
                              <span className="tabular-nums">
                                {rawToUi(e.amountRaw, e.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })} {ASSET_LABEL[e.assetMint] ?? short(e.assetMint)}
                              </span>
                              <span className="tabular-nums">{usdCents(e.amountUsd)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Panel>
                ) : (
                  <Panel className="p-5">
                    <p className="text-[14px] text-ink-2">No protocol treasury yet. Creating one mints a custodial key under KMS, pins its address in protocol config, and subscribes it to the Helius webhook when Helius is configured.</p>
                    <div className="mt-4">
                      {configured.kms ? <CreateTreasuryButton /> : <p className="font-mono text-[12px] text-stamp">FEE_ROUTER_KMS_KEY is not configured; the key cannot be created.</p>}
                    </div>
                  </Panel>
                )}
              </section>

              <section>
                <SectionHead title="$ROUTE" aside={stats.protocolMint ? "launched" : "not launched"} />
                <Panel className="p-5">
                  {stats.protocolMint ? (
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Pill tone="verify">live</Pill>
                        <Mono className="break-all">{stats.protocolMint}</Mono>
                        <CopyButton value={stats.protocolMint} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-4 font-mono text-[12px]">
                        <ExternalLink href={`https://pump.fun/coin/${stats.protocolMint}`}>pump.fun</ExternalLink>
                        <ExternalLink href={solscanAddr(stats.protocolMint)}>Solscan</ExternalLink>
                        <Link href={`/v/${COMMONS_VAULT_SLUG}`} className="underline decoration-line-strong underline-offset-4">
                          Commons vault
                        </Link>
                        {stats.protocolLaunchId ? <span className="text-muted">launch {stats.protocolLaunchId}</span> : null}
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
                      <LaunchProtocolForm blocked={launchBlocked} />
                      <div className="text-[12px] leading-relaxed text-muted">
                        <Eyebrow>Creator fee split (proposed)</Eyebrow>
                        <Row label="Commons vault route" value={bps(PROTOCOL_SPLIT.commonsBps)} />
                        <Row label="Protocol treasury" value={bps(PROTOCOL_SPLIT.treasuryBps)} />
                        <p className="mt-3">Launched on pump.fun with the protocol treasury as the creator wallet, so 100% of creator fees accrue to the treasury on-chain. The split is applied by the treasury after the fact: the Commons share is forwarded to the Commons vault&rsquo;s route address and shows up there as fee events. pump.fun takes its platform cut before the creator share.</p>
                        <p className="mt-2">Your custodial admin wallet funds the treasury with the dev buy plus 0.03 SOL, and the treasury key signs the create transaction.</p>
                      </div>
                    </div>
                  )}
                </Panel>
              </section>

              <section>
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

              <section>
                <SectionHead title="Integrations" />
                <div className="grid gap-3 sm:grid-cols-2">
                  {integrations.map((i) => (
                    <Panel key={i.key} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[14px]">{i.label}</span>
                        <Pill tone={i.ok === true ? "verify" : i.ok === false ? "stamp" : "muted"}>{i.ok === true ? "ready" : i.ok === false ? "missing" : "check failed"}</Pill>
                      </div>
                      <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted break-words">{i.detail}</div>
                    </Panel>
                  ))}
                </div>
                <div className="mt-6">
                  <ZentroPanel />
                </div>
              </section>

              <section>
                <SectionHead title="Operators" aside={`${operators.length} with elevated roles`} />
                {operators.length === 0 ? (
                  <p className="text-[13px] text-muted">No operators or admins. Roles come from OPERATOR_EMAILS / ADMIN_EMAILS at sign-in.</p>
                ) : (
                  <div className="flex flex-col">
                    {operators.map((o) => (
                      <div key={o.user.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 py-2.5 rule-dashed text-[13px]">
                        <span className="truncate">
                          {o.user.name ?? o.user.email}
                          <span className="ml-2 font-mono text-[11px] text-muted">{o.user.email}</span>
                        </span>
                        <Pill tone={o.user.role === "admin" ? "ink" : "muted"}>{o.user.role}</Pill>
                        <Pill tone={o.gmailConnected ? "verify" : "muted"}>{o.gmailConnected ? "gmail connected" : "no gmail"}</Pill>
                        <span className="font-mono text-[11px] text-muted">{timeAgo(o.user.lastLoginAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <aside className="flex flex-col gap-4">
              <Panel className="p-5">
                <Eyebrow>Danger zone</Eyebrow>
                <p className="mt-2 text-[13px] text-ink-2">Rewrites the Helius subscription to every token route address plus the protocol treasury. Safe to repeat.</p>
                <div className="mt-4">
                  <RegisterHeliusButton disabled={!configured.helius} reason={!configured.helius ? helius.detail : undefined} />
                </div>
              </Panel>
              <Panel className="p-5">
                <Eyebrow>Roles</Eyebrow>
                <p className="mt-2 text-[13px] text-ink-2">Email in OPERATOR_EMAILS grants operator; in ADMIN_EMAILS grants admin. Roles are never demoted automatically.</p>
              </Panel>
            </aside>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
