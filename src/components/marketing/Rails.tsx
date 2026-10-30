import { Reveal } from "@/components/motion";
import { Pill, cx } from "@/components/ui";
import { Section, SectionHead } from "./Section";

const RAILS = [
  {
    name: "Operator card",
    status: { label: "live", tone: "verify" as const },
    who: "GoFundMe, LaunchGood, JustGiving, any card checkout",
    how: "Vault USDC tops up a Zentro card. A named operator makes the donation on the fundraiser's own page, attaches the confirmation, and signs the receipt.",
    honesty: "A human executes each payment. That is deliberate: consumer fundraising platforms have no donation API and automating their checkout violates their terms.",
  },
  {
    name: "On-chain USDC",
    status: { label: "live", tone: "usdc" as const },
    who: "Causes that hold a Solana wallet",
    how: "A single USDC transfer from the vault treasury to the cause's address. The transfer signature is the rail reference.",
    honesty: "Only works when the cause can custody USDC. Most cannot, which is why the other rails exist.",
  },
  {
    name: "Issuing card",
    status: { label: "in integration", tone: "muted" as const },
    who: "Platforms whose terms permit programmatic card donations",
    how: "A virtual card issued per vault (Rain or Bridge), funded directly from USDC, charged at checkout without an operator in the loop.",
    honesty: "Not yet used for any delivery. Listed so the roadmap is legible, not because it is done.",
  },
  {
    name: "GoFundMe Pro",
    status: { label: "for nonprofits", tone: "muted" as const },
    who: "Registered nonprofits on GoFundMe Pro (formerly Classy)",
    how: "OAuth into the nonprofit's account and post donations through the official API, with the receipt id in the donation memo.",
    honesty: "Does not apply to personal campaigns, which is most of GoFundMe.",
  },
];

/** Bento of rails. Hairline grid, one honesty note per cell. */
export function Rails() {
  return (
    <Section id="rails">
      <SectionHead no="03" eyebrow="Delivery rails" title={<>Delivered through the rail the fundraiser <span className="italic">already</span> uses.</>} lede="Fee Router does not ask a family to open a wallet. It pays the way their page already accepts, and records how." />
      <div className="mt-14 grid hairline md:grid-cols-2">
        {RAILS.map((r, i) => (
          <Reveal key={r.name} delay={i * 0.06} className={cx("flex flex-col gap-5 p-6 md:p-8", i > 0 && "hairline-t", i % 2 === 1 && "md:border-l md:border-line", i === 1 && "md:border-t-0")}>
            <div className="flex items-center justify-between gap-4">
              <h3 className="font-display text-[28px] leading-none">{r.name}</h3>
              <Pill tone={r.status.tone}>{r.status.label}</Pill>
            </div>
            <dl className="grid gap-3 text-[14px] leading-relaxed">
              <div className="grid grid-cols-[72px_1fr] gap-4">
                <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Who</dt>
                <dd className="text-ink-2">{r.who}</dd>
              </div>
              <div className="grid grid-cols-[72px_1fr] gap-4">
                <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">How</dt>
                <dd className="text-ink-2">{r.how}</dd>
              </div>
            </dl>
            <p className="mt-auto hairline-t pt-4 font-mono text-[12px] leading-relaxed text-muted">{r.honesty}</p>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
