import type { Metadata } from "next";
import Link from "next/link";
import { Header, Footer } from "@/components/shell";
import { ButtonLink, Container, cx, Eyebrow } from "@/components/ui";
import { VaultCard } from "@/components/app/VaultCard";
import { CATEGORY_LABEL } from "@/components/app";
import { countVaults, getGlobalStats, listVaults, type VaultSort } from "@/lib/db/queries";
import { compactUsd, count } from "@/lib/format";

export const metadata: Metadata = { title: "Explore vaults", description: "Every vault on Fee Router, with fees routed, dollars delivered and receipts published." };

const CATEGORIES = ["all", "medical", "water", "education"] as const;
const SORTS = ["delivered", "fees", "recent"] as const satisfies readonly VaultSort[];
const PAGE_SIZE = 24;

function href(q: { cat: string; verified: boolean; sort: VaultSort; page?: number }): string {
  const p = new URLSearchParams();
  if (q.cat !== "all") p.set("cat", q.cat);
  if (q.verified) p.set("verified", "1");
  if (q.sort !== "delivered") p.set("sort", q.sort);
  if (q.page && q.page > 1) p.set("page", String(q.page));
  const s = p.toString();
  return s ? `/explore?${s}` : "/explore";
}

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const cat = typeof sp.cat === "string" && (CATEGORIES as readonly string[]).includes(sp.cat) ? sp.cat : "all";
  const verified = sp.verified === "1";
  const sort: VaultSort = typeof sp.sort === "string" && (SORTS as readonly string[]).includes(sp.sort) ? (sp.sort as VaultSort) : "delivered";
  const filter = { category: cat === "all" ? undefined : cat, verified };

  const [stats, matching] = await Promise.all([getGlobalStats(), countVaults(filter)]);
  const pages = Math.max(1, Math.ceil(matching / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, typeof sp.page === "string" && /^\d+$/.test(sp.page) ? Number(sp.page) : 1));
  const shown = matching === 0 ? [] : await listVaults({ ...filter, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  const chip = "inline-flex items-center h-10 sm:h-8 px-3 rounded-full font-mono text-[11px] uppercase tracking-[0.12em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp";
  const on = "bg-ink text-paper";
  const off = "hairline text-ink-2 hover:bg-paper-2";

  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="pt-12 pb-20">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Eyebrow>Explore</Eyebrow>
              <h1 className="mt-3 font-display text-[44px] sm:text-[56px] leading-[0.95] tracking-tight text-balance">
                {stats.vaults === 0 ? (
                  <>
                    No vaults <span className="italic">yet.</span>
                  </>
                ) : (
                  <>
                    {count(stats.vaults)} vaults. <span className="italic">{compactUsd(stats.deliveredUsd)}</span> delivered. {count(stats.deliveries)} receipts.
                  </>
                )}
              </h1>
              <p className="mt-4 max-w-[52ch] text-[15px] text-ink-2">
                Each vault points token revenue at one fundraiser. Every delivery is receipted and anchored on-chain.{" "}
                <Link href="/leaderboard" className="hit underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  See the leaderboard
                </Link>
                .
              </p>
            </div>
            <ButtonLink href="/connect" variant="stamp">
              Connect a fundraiser
            </ButtonLink>
          </div>

          <nav aria-label="Filters" className="mt-10 flex flex-wrap items-center gap-2 hairline-t hairline-b py-3">
            {CATEGORIES.map((c) => (
              <Link key={c} href={href({ cat: c, verified, sort })} className={cx(chip, cat === c ? on : off)} aria-current={cat === c ? "true" : undefined}>
                {c === "all" ? "All" : CATEGORY_LABEL[c]}
              </Link>
            ))}
            <span className="mx-2 h-5 w-px bg-line" aria-hidden />
            <Link href={href({ cat, verified: !verified, sort })} className={cx(chip, verified ? "bg-verify/10 text-verify border border-verify/30" : off)} aria-pressed={verified}>
              Verified only
            </Link>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted mr-1">Sort</span>
              {SORTS.map((s) => (
                <Link key={s} href={href({ cat, verified, sort: s })} className={cx(chip, sort === s ? on : off)} aria-current={sort === s ? "true" : undefined}>
                  {s === "delivered" ? "Delivered" : s === "fees" ? "Fees routed" : "Newest"}
                </Link>
              ))}
            </span>
          </nav>

          {stats.vaults === 0 ? (
            <div className="mt-16 text-center">
              <p className="font-display text-[28px]">The first vault is not here yet.</p>
              <p className="mx-auto mt-2 max-w-[48ch] text-[14px] text-muted">A vault appears the moment a fundraiser is connected and a token routes its creator fees to it. Every delivery after that prints a receipt.</p>
              <ButtonLink href="/connect" className="mt-6">
                Connect a fundraiser
              </ButtonLink>
            </div>
          ) : shown.length === 0 ? (
            <div className="mt-16 text-center">
              <p className="font-display text-[28px]">No vaults match.</p>
              <p className="mt-2 text-[14px] text-muted">Try a different category or turn off the verified filter.</p>
              <Link href="/explore" className="mt-6 inline-flex min-h-10 items-center font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
                Clear filters
              </Link>
            </div>
          ) : (
            <>
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((v) => (
                  <VaultCard key={v.vault.id} v={v} heading="h2" />
                ))}
              </div>
              {pages > 1 ? (
                <nav aria-label="Pagination" className="mt-10 flex items-center justify-between gap-4 hairline-t pt-4 font-mono text-[12px] uppercase tracking-[0.12em]">
                  {page > 1 ? (
                    <Link href={href({ cat, verified, sort, page: page - 1 })} rel="prev" className={cx(chip, off)}>
                      ← Previous
                    </Link>
                  ) : (
                    <span className={cx(chip, "hairline text-muted opacity-50")} aria-disabled="true">
                      ← Previous
                    </span>
                  )}
                  <span className="text-muted">
                    Page {count(page)} of {count(pages)}
                  </span>
                  {page < pages ? (
                    <Link href={href({ cat, verified, sort, page: page + 1 })} rel="next" className={cx(chip, off)}>
                      Next →
                    </Link>
                  ) : (
                    <span className={cx(chip, "hairline text-muted opacity-50")} aria-disabled="true">
                      Next →
                    </span>
                  )}
                </nav>
              ) : null}
            </>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
