import Link from "next/link";
import { Reveal } from "@/components/motion";
import { ButtonLink, Pill, TokenMark } from "@/components/ui";
import type { VaultCard } from "@/lib/db/queries";
import { count, timeAgo, usd } from "@/lib/format";
import { Section, SectionHead } from "./Section";

const PLATFORM: Record<string, string> = { gofundme: "GoFundMe", launchgood: "LaunchGood", justgiving: "JustGiving", gogetfunding: "GoGetFunding", everyorg: "Every.org", stripe_link: "Stripe", onchain: "On-chain", other: "Other" };

/** Marketing-lean vault tile: image band, name, delivered/fees, tokens. */
function VaultTile({ v, delay }: { v: VaultCard; delay: number }) {
  const { vault, cause, totals, tokens } = v;
  return (
    <Reveal as="li" delay={delay} className="flex flex-col">
      <Link href={`/v/${vault.slug}`} className="group flex flex-1 flex-col hairline rounded-lg bg-paper transition-colors hover:bg-paper-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
        <div className="relative aspect-[4/3] overflow-hidden rounded-t-lg bg-paper-2 bg-cover bg-center" style={cause.imageUrl ? { backgroundImage: `url(${cause.imageUrl})` } : undefined}>
          <div className="absolute left-3 top-3 flex gap-2">
            <Pill tone={cause.verificationStatus === "verified" ? "verify" : "muted"}>{cause.verificationStatus}</Pill>
          </div>
          <div className="absolute bottom-3 right-3 flex -space-x-1.5">
            {tokens.map((t) => (
              <span key={t.id} className="rounded-full ring-2 ring-paper">
                <TokenMark symbol={t.symbol} imageUrl={t.imageUrl} size={26} />
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-1 flex-col p-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            {PLATFORM[cause.platform] ?? cause.platform} · {cause.location ?? "—"}
          </div>
          <h3 className="mt-2 font-display text-[26px] leading-tight">{vault.name}</h3>
          <p className="mt-1 line-clamp-2 text-[14px] leading-relaxed text-ink-2">{cause.title}</p>
          <dl className="mt-5 grid grid-cols-2 gap-4 hairline-t pt-4">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Delivered</dt>
              <dd className="mt-1 font-mono text-[18px] tabular-nums">{usd(totals.deliveredUsd)}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Fees routed</dt>
              <dd className="mt-1 font-mono text-[18px] tabular-nums">{usd(totals.feesUsd)}</dd>
            </div>
          </dl>
          <div className="mt-auto flex items-center justify-between pt-4 font-mono text-[11px] text-muted">
            <span>
              {count(totals.deliveryCount)} receipt{totals.deliveryCount === 1 ? "" : "s"} · {tokens.map((t) => `$${t.symbol}`).join(" ")}
            </span>
            <span>{totals.lastDeliveryAt ? timeAgo(totals.lastDeliveryAt) : "no delivery yet"}</span>
          </div>
        </div>
      </Link>
    </Reveal>
  );
}

export function FeaturedVaults({ vaults }: { vaults: VaultCard[] }) {
  return (
    <Section id="vaults">
      <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <SectionHead no="05" eyebrow="Vaults" title={<>Live vaults, live ledgers.</>} className="md:flex-1" />
        <ButtonLink href="/explore" variant="ghost" className="shrink-0">
          Explore all vaults
        </ButtonLink>
      </div>
      {vaults.length === 0 ? (
        <div className="mt-12 hairline rounded-lg px-6 py-14 text-center">
          <div className="font-display text-[28px]">No vaults yet.</div>
          <p className="mx-auto mt-3 max-w-[48ch] text-[15px] text-muted">The first vault appears here the moment a fundraiser is connected and a token routes its fees. Every delivery after that prints a receipt.</p>
          <ButtonLink href="/connect" className="mt-6">
            Connect a fundraiser
          </ButtonLink>
        </div>
      ) : (
        <ul className="mt-12 grid gap-5 md:grid-cols-3">
          {vaults.map((v, i) => (
            <VaultTile key={v.vault.id} v={v} delay={i * 0.08} />
          ))}
        </ul>
      )}
    </Section>
  );
}
