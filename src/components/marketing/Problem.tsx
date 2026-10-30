import { Reveal } from "@/components/motion";
import { Eyebrow } from "@/components/ui";
import { Section } from "./Section";

/** Why Fee Router exists. Two columns; left is the sentence, right is why. */
export function Problem() {
  return (
    <Section id="why">
      <div className="grid gap-12 md:grid-cols-12">
        <Reveal className="md:col-span-6">
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-[11px] text-stamp">02</span>
            <Eyebrow>The problem, plainly</Eyebrow>
          </div>
          <h2 className="mt-6 max-w-[16ch] text-balance font-display text-[clamp(38px,5.4vw,72px)] leading-[0.98] tracking-[-0.015em]">
            GoFundMe doesn&rsquo;t take crypto. <span className="italic">Neither does the hospital.</span>
          </h2>
        </Reveal>
        <Reveal delay={0.12} className="md:col-span-5 md:col-start-8">
          <div className="space-y-5 text-[17px] leading-relaxed text-ink-2">
            <p>Most fundraisers on the internet take cards and nothing else. A family raising money for a child&rsquo;s treatment on GoFundMe cannot accept a token, a wallet transfer or a stablecoin, and the hospital invoices in dollars.</p>
            <p>Meanwhile, crypto communities launch tokens for causes like these every week, and the trading fees are often worth more than the donations. None of that money can reach the campaign. Nobody on the fundraiser&rsquo;s side should have to learn what a wallet is.</p>
            <p>Fee Router is the piece in between. It routes the fees to a vault, converts them to USDC, pays the fundraiser through the rail it already uses, and publishes a receipt that anyone can check. The community keeps trading. The family gets dollars. The evidence is public.</p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
