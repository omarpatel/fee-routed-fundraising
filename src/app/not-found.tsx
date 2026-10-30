import type { Metadata } from "next";
import { connection } from "next/server";
import { Footer, Header } from "@/components/shell";
import { ButtonLink, Container, Eyebrow } from "@/components/ui";

export const metadata: Metadata = { title: "Not found", description: "There is no page at this address.", robots: { index: false } };

export default async function NotFound() {
  // The footer reads ledger stats; render per request instead of baking build-time numbers into a static page.
  await connection();
  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="py-20 lg:py-32">
          <Eyebrow>404</Eyebrow>
          <h1 className="mt-3 font-display text-[clamp(44px,8vw,96px)] leading-none tracking-[-0.01em]">
            Nothing here<span className="text-stamp">.</span>
          </h1>
          <p className="mt-5 max-w-[48ch] text-[16px] leading-relaxed text-ink-2">No vault, receipt or page lives at this address. Receipts are at /r/&lt;id&gt; and vaults at /v/&lt;slug&gt;; both are listed from Explore.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/" variant="ink" size="lg">
              Home
            </ButtonLink>
            <ButtonLink href="/explore" variant="ghost" size="lg">
              Explore vaults
            </ButtonLink>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
