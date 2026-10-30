import { FlowDiagram, type FlowNode } from "@/components/motion";
import { Container } from "@/components/ui";
import { SectionHead } from "./Section";

const NODES: FlowNode[] = [
  { label: "Token trading", sub: "pump.fun · Bags · Meteora" },
  { label: "Creator fees", sub: "SOL, on every swap" },
  { label: "Impact Vault", sub: "dedicated route address", tone: "stamp" },
  { label: "USDC", sub: "swept via Jupiter", tone: "usdc" },
  { label: "Rail", sub: "card or on-chain" },
  { label: "Fundraiser", sub: "GoFundMe · LaunchGood · wallet" },
  { label: "Receipt", sub: "sha-256, anchored", tone: "verify" },
];

/** How it works: one path, seven stops, a red dollar that moves as you scroll. */
export function Flow() {
  return (
    <section id="how" className="hairline-t" data-flow-scroll>
      <div className="md:sticky md:top-14">
        <Container wide className="py-20 md:min-h-[calc(100vh-56px)] md:py-24">
          <SectionHead no="01" eyebrow="How it works" title={<>One path from a swap to a stamped receipt.</>} lede="Fees are attributed at the address level, swept to USDC, and delivered through whichever rail the fundraiser already accepts. Nothing here requires the fundraiser to know what a token is." />
          <FlowDiagram nodes={NODES} className="mt-16 md:mt-24" />
          <p className="mt-14 max-w-[60ch] font-mono text-[12px] leading-relaxed text-muted md:mt-24">Scroll to follow a dollar. Each stop is a table in the ledger: fee_events, sweeps, deliveries, receipt_artifacts. Nothing is aggregated before it is recorded.</p>
        </Container>
      </div>
      <div className="hidden md:block md:h-[90vh]" aria-hidden="true" />
    </section>
  );
}
