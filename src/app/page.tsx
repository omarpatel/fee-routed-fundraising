import { FeaturedVaults, FinalCta, Flow, Hero, Launch, Problem, Proof, Rails, Stats, Ticker } from "@/components/marketing";
import { Footer, Header } from "@/components/shell";
import { getGlobalStats, getReceipt, listRecentDeliveries, listVaults } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [stats, recent, vaults] = await Promise.all([getGlobalStats(), listRecentDeliveries(12), listVaults({ limit: 3 })]);
  // The hero object is the largest recent delivery: the receipt worth reading first.
  const featured = recent.reduce<(typeof recent)[number] | null>((best, d) => (best && best.amountUsdc >= d.amountUsdc ? best : d), null);
  const receipt = featured ? await getReceipt(featured.id) : null;

  return (
    <>
      <Header />
      <main className="flex-1">
        <Hero receipt={receipt} />
        <Ticker items={recent} />
        <Stats stats={stats} />
        <Flow />
        <Problem />
        <Rails />
        {receipt && <Proof receipt={receipt} />}
        <FeaturedVaults vaults={vaults} />
        <Launch />
        <FinalCta receiptId={receipt?.delivery.id ?? null} />
      </main>
      <Footer />
    </>
  );
}
