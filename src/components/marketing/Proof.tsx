import Link from "next/link";
import { Reveal } from "@/components/motion";
import { ButtonLink, Eyebrow } from "@/components/ui";
import type { ReceiptDetail } from "@/lib/db/queries";
import { receiptNo, short } from "@/lib/format";
import { MEMO_PREFIX, canonicalReceipt } from "@/lib/proof";
import { Section } from "./Section";

const STEPS = [
  { k: "01", title: "Canonical JSON", body: "Every field that describes the delivery, keys sorted at every level, no whitespace, nulls kept. Status is excluded so the bytes never change after finalize." },
  { k: "02", title: "SHA-256", body: "The hash of those exact bytes is the receipt id's fingerprint. Evidence files are referenced by their own hashes, so they cannot be swapped later." },
  { k: "03", title: "Solana memo", body: "The operator anchors the hash in a memo transaction. The chain timestamps it; the receipt page links the signature." },
];

/** Dark ledger block: what a receipt is made of, using the hero receipt's real bytes. */
export function Proof({ receipt }: { receipt: ReceiptDetail }) {
  const canonical = canonicalReceipt(receipt);
  const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
  const { delivery } = receipt;
  return (
    <Section id="proof" dark>
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <Reveal>
            <div className="flex items-baseline gap-4">
              <span className="font-mono text-[11px] text-stamp">04</span>
              <Eyebrow>Proof</Eyebrow>
            </div>
            <h2 className="mt-6 max-w-[14ch] text-balance font-display text-[clamp(38px,5vw,68px)] leading-[0.98] tracking-[-0.015em]">
              Anyone can <span className="italic">recompute</span> the hash.
            </h2>
            <p className="mt-6 max-w-[48ch] text-[17px] leading-relaxed text-paper/75">A receipt is not a screenshot. It is a fixed set of bytes, a hash of those bytes, and a public place where that hash was written down before anyone could argue about it.</p>
          </Reveal>
          <ol className="mt-10 space-y-6">
            {STEPS.map((s, i) => (
              <Reveal key={s.k} as="li" delay={0.08 * i} className="grid grid-cols-[40px_1fr] gap-4 hairline-t pt-5">
                <span className="font-mono text-[11px] text-stamp">{s.k}</span>
                <div>
                  <h3 className="font-display text-[24px] leading-none">{s.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-paper/70">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </ol>
          <div className="mt-10 flex flex-wrap gap-3">
            <ButtonLink href="/docs#verify" variant="paper">
              How to verify
            </ButtonLink>
            <ButtonLink href={`/r/${delivery.id}`} variant="ghost" className="text-paper hover:bg-ledger-2">
              Open {receiptNo(delivery.ordinal)}
            </ButtonLink>
          </div>
        </div>
        <Reveal delay={0.1} className="min-w-0 lg:col-span-7">
          <div className="hairline rounded-lg bg-ledger-2">
            <div className="flex items-center justify-between gap-4 px-5 py-3 hairline-b font-mono text-[11px] uppercase tracking-[0.14em] text-paper/55">
              <span>canonical · {receiptNo(delivery.ordinal)}</span>
              <span>{canonical.length} bytes</span>
            </div>
            <pre className="max-h-[420px] overflow-auto px-5 py-4 font-mono text-[12px] leading-[1.55] text-paper/85" tabIndex={0}>
              {pretty}
            </pre>
            <dl className="grid gap-3 px-5 py-4 hairline-t font-mono text-[12px] md:grid-cols-[110px_1fr]">
              <dt className="uppercase tracking-[0.14em] text-paper/55">sha-256</dt>
              <dd className="break-all text-paper">{delivery.receiptHash ?? "not yet finalized"}</dd>
              <dt className="uppercase tracking-[0.14em] text-paper/55">memo</dt>
              <dd className="break-all text-paper/85">
                {MEMO_PREFIX}
                {delivery.id}:{delivery.receiptHash ? short(delivery.receiptHash, 10, 6) : "<hash>"}
              </dd>
              <dt className="uppercase tracking-[0.14em] text-paper/55">anchor</dt>
              <dd className="break-all">
                {delivery.anchorTxSig ? (
                  <Link href={`/r/${delivery.id}`} className="hit text-verify underline decoration-verify/40 underline-offset-4 hover:decoration-verify">
                    {short(delivery.anchorTxSig, 12, 8)}
                  </Link>
                ) : (
                  <span className="text-paper/55">not anchored</span>
                )}
              </dd>
            </dl>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
