import { Reveal } from "@/components/motion";
import { ButtonLink, Eyebrow, Stamp } from "@/components/ui";
import { Section } from "./Section";

const RULES = [
  { k: "Rule 1", title: "At least 50% of creator fees routed", body: "The token's fee recipient must point at least half of creator fees at a Fee Router route address, and the redirect must be locked on-chain." },
  { k: "Rule 2", title: "The cause is verified", body: "A named operator confirms the organizer's identity, the campaign's ownership, and where money is actually going before the first delivery." },
  { k: "Rule 3", title: "Every receipt is public", body: "Deliveries are hashed, anchored, and listed on the vault page. If a delivery cannot be evidenced, it does not count." },
];

/** $ROUTE block: launch through Fee Router, route the fees, get matched from the Commons vault. */
export function Launch() {
  return (
    <Section id="launch">
      <div className="grid gap-12 lg:grid-cols-12">
        <Reveal className="lg:col-span-5">
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-[11px] text-stamp">06</span>
            <Eyebrow>Launch under Fee Router · $ROUTE</Eyebrow>
          </div>
          <h2 className="mt-6 max-w-[14ch] text-balance font-display text-[clamp(38px,5vw,68px)] leading-[0.98] tracking-[-0.015em]">
            Launch a token. Route the fees. <span className="italic">Get matched.</span>
          </h2>
          <p className="mt-6 max-w-[48ch] text-[17px] leading-relaxed text-ink-2">Tokens launched through Fee Router that follow the three rules are eligible for a match from the Commons vault. The match is paid on the same rail, with the same receipt.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/launch" size="lg">
              Launch a vault
            </ButtonLink>
          </div>
        </Reveal>
        <div className="lg:col-span-6 lg:col-start-7">
          <ol className="hairline rounded-lg">
            {RULES.map((r, i) => (
              <Reveal key={r.k} as="li" delay={0.08 * i} className={`grid gap-4 p-6 md:grid-cols-[88px_1fr] md:p-7 ${i > 0 ? "hairline-t" : ""}`}>
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-stamp">{r.k}</span>
                <div>
                  <h3 className="font-display text-[26px] leading-tight">{r.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{r.body}</p>
                </div>
              </Reveal>
            ))}
          </ol>
          <div className="mt-6 flex items-center justify-end">
            <Stamp className="text-[16px]">Eligible for match</Stamp>
          </div>
        </div>
      </div>
    </Section>
  );
}
