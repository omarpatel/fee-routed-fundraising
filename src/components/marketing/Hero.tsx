import { Reveal } from "@/components/motion";
import { ButtonLink, Container, Eyebrow } from "@/components/ui";
import type { ReceiptDetail } from "@/lib/db/queries";
import { HeroReceipt, HeroReceiptEmpty } from "./HeroReceipt";

export function Hero({ receipt }: { receipt: ReceiptDetail | null }) {
  return (
    <section className="relative overflow-hidden">
      <Container wide className="grid gap-14 pb-20 pt-16 md:pt-24 lg:grid-cols-12 lg:gap-8 lg:pb-28">
        <div className="lg:col-span-7">
          <Reveal>
            <Eyebrow>Payment layer · Solana</Eyebrow>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 className="mt-6 max-w-[11ch] text-balance font-display text-[clamp(48px,8vw,120px)] leading-[0.94] tracking-[-0.02em]">
              Fund <span className="italic">anyone</span> on the internet.
            </h1>
          </Reveal>
          <Reveal delay={0.14}>
            <p className="mt-8 max-w-[52ch] text-[17px] leading-relaxed text-ink-2 md:text-[19px]">Connect a fundraiser. Redirect token revenue. We convert it to USDC, deliver it through the rail the fundraiser already uses, and publish a receipt for every dollar.</p>
          </Reveal>
          <Reveal delay={0.22} className="mt-10 flex flex-wrap items-center gap-3">
            <ButtonLink href="/launch" size="lg">
              Launch a vault
            </ButtonLink>
            {receipt && (
              <ButtonLink href={`/r/${receipt.delivery.id}`} variant="ghost" size="lg">
                See a receipt
              </ButtonLink>
            )}
          </Reveal>
          <Reveal delay={0.3} className="mt-14 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            <span>pump.fun · Bags · Meteora</span>
            <span>Jupiter → USDC</span>
            <span>Card · On-chain</span>
          </Reveal>
        </div>
        <div className="lg:col-span-5 lg:pt-4">{receipt ? <HeroReceipt receipt={receipt} /> : <HeroReceiptEmpty />}</div>
      </Container>
    </section>
  );
}
