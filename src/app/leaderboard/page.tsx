import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Header, Footer } from "@/components/shell";
import { ButtonLink, Container, cx, Eyebrow, StatusPill, TokenMark } from "@/components/ui";
import { SectionHead, SourcePill } from "@/components/app";
import { getLeaderboard } from "@/lib/db/queries";
import { count, usdCents } from "@/lib/format";

/** Ranks read the live ledger. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Leaderboard", description: "Tokens and vaults ranked by dollars delivered to real fundraisers, with fees routed and receipts behind every number." };

const LIMIT = 50;

export default async function LeaderboardPage() {
  const { tokens, vaults } = await getLeaderboard(LIMIT);

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-12 pb-24">
          <Eyebrow>Leaderboard</Eyebrow>
          <h1 className="mt-3 font-display text-[44px] sm:text-[56px] leading-[0.95] tracking-tight text-balance">
            Ranked by what <span className="italic">arrived.</span>
          </h1>
          <p className="mt-4 max-w-[56ch] text-[15px] text-ink-2">Delivered means paid to the fundraiser and receipted. A token&apos;s share comes from the per-token allocation printed on each receipt. Fees routed is what reached the vault.</p>

          {tokens.length === 0 && vaults.length === 0 ? (
            <div className="mt-16 text-center">
              <p className="font-display text-[28px]">Nothing to rank yet.</p>
              <p className="mx-auto mt-2 max-w-[48ch] text-[14px] text-muted">The board fills in once a token routes its first creator fees to a vault.</p>
              <ButtonLink href="/connect" className="mt-6">
                Connect a fundraiser
              </ButtonLink>
            </div>
          ) : (
            <>
              <section className="mt-12">
                <SectionHead title="Tokens" aside={`top ${count(Math.min(tokens.length, LIMIT))} by delivered`} id="tokens" />
                <Board columns={[{ label: "Token" }, { label: "Funds" }, { label: "Fees routed", right: true }, { label: "Delivered", right: true }]}>
                  {tokens.map((t, i) => (
                    <tr key={t.token.id} className="rule-dashed align-middle">
                      <td className={RANK}>{String(i + 1).padStart(2, "0")}</td>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2.5">
                          <TokenMark symbol={t.token.symbol} imageUrl={t.token.imageUrl} size={28} />
                          <div>
                            <div className="font-mono text-[13px]">${t.token.symbol}</div>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted">
                              {t.token.name} <SourcePill source={t.token.source} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <Link href={`/v/${t.vault.slug}`} className="hit hover:underline underline-offset-4">
                          {t.vault.name}
                        </Link>
                        <div className="text-[11px] text-muted">{t.causeTitle}</div>
                      </td>
                      <Money usd={t.feesUsd} />
                      <Money usd={t.deliveredUsd} strong last />
                    </tr>
                  ))}
                </Board>
              </section>

              <section className="mt-16">
                <SectionHead title="Vaults" aside={`top ${count(Math.min(vaults.length, LIMIT))} by delivered`} id="vaults" />
                <Board columns={[{ label: "Vault" }, { label: "Receipts", right: true }, { label: "Fees routed", right: true }, { label: "Delivered", right: true }, { label: "Of fees", right: true }]}>
                  {vaults.map((v, i) => (
                    <tr key={v.vault.id} className="rule-dashed align-middle">
                      <td className={RANK}>{String(i + 1).padStart(2, "0")}</td>
                      <td className="py-3 pr-3">
                        <Link href={`/v/${v.vault.slug}`} className="hit hover:underline underline-offset-4">
                          {v.vault.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <Link href={`/c/${v.cause.slug}`} className="hover:underline underline-offset-4">
                            {v.cause.title}
                          </Link>
                          <StatusPill status={v.cause.verificationStatus} />
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-right font-mono tabular-nums">{count(v.deliveryCount)}</td>
                      <Money usd={v.feesUsd} />
                      <Money usd={v.deliveredUsd} strong />
                      <td className="py-3 pr-5 sm:pr-0 text-right font-mono tabular-nums text-muted">{v.feesUsd > 0 ? `${((v.deliveredUsd / v.feesUsd) * 100).toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
                </Board>
                <p className="mt-4 text-[12px] text-muted">Of fees: delivered ÷ fees routed. Below 100% means fees still waiting for a threshold, a vault that donates less than all of its fees, or swap slippage.</p>
              </section>
            </>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}

/** Last column pads to the page edge on mobile, like the other ledger tables. */
const LAST = "pr-5 sm:pr-0";

function Board({ columns, children }: { columns: { label: string; right?: boolean }[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-5 sm:mx-0">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="text-left hairline-b">
            <th scope="col" className="py-2 pl-5 sm:pl-0 pr-3 font-normal w-12">
              <Eyebrow>#</Eyebrow>
            </th>
            {columns.map((c, i) => (
              <th key={c.label} scope="col" className={cx("py-2 font-normal", i === columns.length - 1 ? LAST : "pr-3", c.right && "text-right")}>
                <Eyebrow>{c.label}</Eyebrow>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const RANK = "py-3 pl-5 sm:pl-0 pr-3 font-mono text-[12px] tabular-nums text-muted";

function Money({ usd, strong, last }: { usd: number; strong?: boolean; last?: boolean }) {
  return <td className={cx("py-3 text-right font-mono tabular-nums", last ? LAST : "pr-3", strong ? "text-ink" : "text-ink-2")}>{usdCents(usd)}</td>;
}
