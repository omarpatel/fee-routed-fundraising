import Link from "next/link";
import { AuthButton } from "@/components/auth";
import { Wordmark } from "@/components/brand";
import { ButtonLink, Container } from "@/components/ui";
import { getGlobalStats } from "@/lib/db/queries";
import { compactUsd, count } from "@/lib/format";
import { HeaderFrame } from "./HeaderFrame";
import { MobileNav } from "./MobileNav";

const NAV = [
  { href: "/explore", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/connect", label: "Connect" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  return (
    <HeaderFrame>
      <Container wide className="flex h-14 items-center justify-between gap-6">
        <Link href="/" aria-label="Fee Router home" className="flex min-h-10 items-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stamp">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {NAV.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-10 items-center text-[13px] tracking-tight text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stamp">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <AuthButton />
          </div>
          <ButtonLink href="/launch" size="sm">
            Launch a vault
          </ButtonLink>
          <MobileNav links={NAV} auth={<AuthButton />} />
        </div>
      </Container>
    </HeaderFrame>
  );
}

/** Public contact. Swap here only. */
const SOCIAL = {
  email: "hello@example.com",
};

const FOOTER: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/explore", label: "Explore vaults" },
      { href: "/leaderboard", label: "Leaderboard" },
      { href: "/launch", label: "Launch a vault" },
      { href: "/connect", label: "Connect a token" },
    ],
  },
  {
    title: "Proof",
    links: [
      { href: "/docs#receipt", label: "Receipt spec" },
      { href: "/docs#verify", label: "Verify a receipt" },
      { href: "/docs#rails", label: "Delivery rails" },
      { href: "/docs", label: "Documentation" },
    ],
  },
  {
    title: "Community",
    links: [
      { href: `mailto:${SOCIAL.email}`, label: SOCIAL.email, external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/terms", label: "Terms of service" },
      { href: "/privacy", label: "Privacy policy" },
      { href: "/docs#roles", label: "Operator policy" },
      { href: "/docs#faq", label: "FAQ" },
    ],
  },
];

export async function Footer() {
  const stats = await getGlobalStats();
  return (
    <footer className="relative mt-auto overflow-hidden hairline-t bg-paper">
      <Container wide className="pt-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
          {FOOTER.map((col) => (
            <div key={col.title}>
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{col.title}</div>
              <ul className="mt-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.external ? (
                      <a href={l.href} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center text-[14px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href} className="inline-flex min-h-10 items-center text-[14px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-14 flex flex-col gap-3 hairline-t pt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted md:flex-row md:items-center md:justify-between">
          {stats.vaults === 0 && stats.deliveries === 0 ? (
            <span>Ledger empty · no receipts yet</span>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span>
                <span className="text-ink">{compactUsd(stats.deliveredUsd)}</span> delivered
              </span>
              <span>
                <span className="text-ink">{compactUsd(stats.feesUsd)}</span> fees routed
              </span>
              <span>
                <span className="text-ink">{count(stats.vaults)}</span> vaults
              </span>
              <span>
                <span className="text-ink">{count(stats.deliveries)}</span> receipts
              </span>
            </div>
          )}
          <span>© {new Date().getFullYear()} Fee Router · Every dollar has a receipt.</span>
        </div>
      </Container>
      <div aria-hidden="true" className="pointer-events-none select-none overflow-hidden">
        <div className="mx-auto w-full max-w-[1440px] px-5 sm:px-8">
          <div className="-mb-[0.22em] mt-4 font-display text-[clamp(120px,24vw,360px)] leading-[0.8] tracking-[-0.02em] text-ink">
            fee-router<span className="text-stamp">.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
