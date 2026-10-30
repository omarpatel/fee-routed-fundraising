import { Reveal } from "@/components/motion";
import { ButtonLink, Container, Stamp } from "@/components/ui";

export function FinalCta({ receiptId }: { receiptId: string | null }) {
  return (
    <section className="hairline-t py-24 md:py-36">
      <Container wide>
        <Reveal className="relative">
          <h2 className="max-w-[12ch] text-balance font-display text-[clamp(52px,10vw,160px)] leading-[0.92] tracking-[-0.02em]">
            Every dollar has a <span className="italic">receipt.</span>
          </h2>
          <Stamp className="absolute right-0 top-2 text-[clamp(18px,3vw,40px)] md:right-[6%] md:top-[18%]">Delivered</Stamp>
        </Reveal>
        <Reveal delay={0.15} className="mt-12 flex flex-wrap items-center gap-3">
          <ButtonLink href="/launch" size="lg">
            Launch a vault
          </ButtonLink>
          <ButtonLink href="/connect" variant="ghost" size="lg">
            Connect a token
          </ButtonLink>
          {receiptId && (
            <ButtonLink href={`/r/${receiptId}`} variant="ghost" size="lg">
              See a receipt
            </ButtonLink>
          )}
        </Reveal>
      </Container>
    </section>
  );
}
