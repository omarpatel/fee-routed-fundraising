import { Counter } from "@/components/motion";
import { Container, cx } from "@/components/ui";
import type { GlobalStats } from "@/lib/db/queries";

/** Four rolling counters straight from the ledger; a single honest line while it is empty. */
export function Stats({ stats }: { stats: GlobalStats }) {
  if (stats.vaults === 0 && stats.deliveries === 0) {
    return (
      <Container wide>
        <div className="hairline-b py-8 flex flex-col gap-3 md:flex-row md:items-baseline md:justify-between">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Ledger · empty</div>
          <p className="max-w-[60ch] text-[15px] text-ink-2">Nothing has been delivered yet. The numbers that belong here are read from the ledger, not typed in; they start with the first connected vault.</p>
        </div>
      </Container>
    );
  }
  const cells: { label: string; value: number; kind: "usd" | "int"; note: string }[] = [
    { label: "Delivered", value: stats.deliveredUsd, kind: "usd", note: "USDC out, to fundraisers" },
    { label: "Fees routed", value: stats.feesUsd, kind: "usd", note: "creator fees attributed to vaults" },
    { label: "Vaults", value: stats.vaults, kind: "int", note: `${stats.tokens} tokens · ${stats.causes} causes` },
    { label: "Receipts", value: stats.deliveries, kind: "int", note: "hashed and anchored" },
  ];
  return (
    <Container wide>
      <dl className="grid grid-cols-2 hairline-b md:grid-cols-4">
        {cells.map((c, i) => (
          <div key={c.label} className={cx("border-line py-8 pr-6", i % 2 === 1 && "border-l pl-6", i >= 2 && "hairline-t md:border-t-0", i > 0 && "md:border-l md:pl-6")}>
            <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{c.label}</dt>
            <dd className="mt-3 font-display text-[clamp(36px,4.5vw,56px)] leading-none tracking-[-0.02em]">
              <Counter value={c.value} kind={c.kind} />
            </dd>
            <dd className="mt-2 font-mono text-[11px] text-muted">{c.note}</dd>
          </div>
        ))}
      </dl>
    </Container>
  );
}
