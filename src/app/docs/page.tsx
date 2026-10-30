import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Toc } from "@/components/marketing/Toc";
import { Footer, Header } from "@/components/shell";
import { Container, Eyebrow, cx } from "@/components/ui";
import { MEMO_PREFIX } from "@/lib/proof";

/** Footer stats and protocol block read the live ledger. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Docs", description: "How Fee Router routes creator fees, converts them to USDC, delivers them through existing rails, and proves every delivery." };

const TOC = [
  { id: "overview", label: "Overview" },
  { id: "fee-routing", label: "Fee routing" },
  { id: "vault", label: "Vault & sweep" },
  { id: "rails", label: "Delivery rails" },
  { id: "receipt", label: "Receipt spec" },
  { id: "verify", label: "Verification" },
  { id: "periods", label: "Periods" },
  { id: "roles", label: "Roles" },
  { id: "faq", label: "FAQ" },
];

/* --- long-form typography, local to docs --- */

function H2({ id, no, children }: { id: string; no: string; children: ReactNode }) {
  return (
    <h2 id={id} className="group flex scroll-mt-24 items-baseline gap-4 hairline-t pt-10 font-display text-[clamp(30px,3.6vw,44px)] leading-none tracking-[-0.01em]">
      <span className="font-mono text-[11px] text-stamp">{no}</span>
      <a href={`#${id}`} className="hit focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stamp">
        {children}
      </a>
    </h2>
  );
}
function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-8 font-display text-[22px] leading-tight">{children}</h3>;
}
function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("mt-4 max-w-[68ch] text-[15.5px] leading-relaxed text-ink-2", className)}>{children}</p>;
}
function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="mt-5 max-w-[760px] hairline rounded-lg bg-paper-2/60">
      {title && <div className="px-4 py-2 hairline-b font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{title}</div>}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-ink" tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-5 max-w-[760px] overflow-x-auto hairline rounded-lg">
      <table className="w-full border-collapse text-left text-[13.5px]">
        <thead>
          <tr className="hairline-b bg-paper-2/60">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cx(i > 0 && "hairline-t", "align-top")}>
              {r.map((c, j) => (
                <td key={j} className={cx("px-4 py-2.5 text-ink-2", j === 0 && "font-mono text-[12.5px] text-ink")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Note({ children }: { children: ReactNode }) {
  return <div className="mt-5 max-w-[68ch] border-l-2 border-stamp pl-4 font-mono text-[12.5px] leading-relaxed text-ink-2">{children}</div>;
}
function Ul({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-4 max-w-[68ch] space-y-2 text-[15.5px] leading-relaxed text-ink-2">
      {items.map((it, i) => (
        <li key={i} className="grid grid-cols-[16px_1fr] gap-3">
          <span className="mt-[0.7em] h-px w-3 bg-ink" aria-hidden="true" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

const CANONICAL_EXAMPLE = `{
  "v": 1,
  "id": "dlv_hope-ward_4",
  "ordinal": 4,
  "vault": { "id": "vlt_hope_ward", "slug": "hope-ward", "name": "Hope Ward Vault", "treasuryAddress": "<base58>" },
  "cause": { "id": "cau_hope_ward", "slug": "hope-ward", "title": "Hope Ward: pediatric cancer treatment", "platform": "gofundme", "url": "https://www.gofundme.com/f/<campaign>" },
  "amountUsdc": 14638.02,
  "amountFiat": 14638.02,
  "fiatCurrency": "USD",
  "fxRate": 1,
  "platformFeeFiat": 424.8,
  "rail": "operator_card",
  "railRef": "Visa •••• 4821 · auth 512930",
  "fundingTxSig": "<solana signature>",
  "allocations": [
    { "tokenId": "tok_cure",  "symbol": "CURE",  "amountUsdc": 7088.29 },
    { "tokenId": "tok_dose",  "symbol": "DOSE",  "amountUsdc": 5224.95 },
    { "tokenId": "tok_hope",  "symbol": "HOPE",  "amountUsdc": 2324.78 }
  ],
  "artifacts": [
    { "kind": "confirmation", "label": "GoFundMe confirmation email", "sha256": "<hex>", "bytes": 48213 },
    { "kind": "statement",    "label": "Card statement line",         "sha256": "<hex>", "bytes": 1024 }
  ],
  "period": { "label": "Week 4", "startsAt": "2026-09-12T00:00:00.000Z", "endsAt": "2026-09-19T00:00:00.000Z" },
  "deliveredAt": "2026-09-19T14:09:52.484Z"
}`;

const VERIFY_SNIPPET = `# 1. fetch the public receipt export for a vault (the slug in its /v/<vault-slug> URL)
curl -s https://example.com/api/vaults/<vault-slug>/receipts.json > receipts.json

# 2. take one receipt's canonical string and hash it (the id in its /r/<receipt-id> URL)
jq -r '.[] | select(.id=="<receipt-id>") | .canonical' receipts.json \\
  | tr -d '\\n' | sha256sum

# 3. compare with the stored hash and the on-chain memo
jq -r '.[] | select(.id=="<receipt-id>") | .hash, .anchorTxSig' receipts.json
# memo in that transaction must read:
#   ${MEMO_PREFIX}<receipt-id>:<hash>`;

export default function DocsPage() {
  return (
    <>
      <Header />
      <main className="flex-1">
        <Container wide className="grid gap-12 py-14 lg:grid-cols-12 lg:py-20">
          <aside className="min-w-0 lg:col-span-3">
            <div className="lg:sticky lg:top-24">
              <Eyebrow>Documentation</Eyebrow>
              <h1 className="mt-3 font-display text-[40px] leading-none">How Fee Router works</h1>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">Plain, precise, and current with the code. Where a thing is not done, it says so.</p>
              <div className="mt-8 hidden lg:block">
                <Toc items={TOC} />
              </div>
            </div>
          </aside>

          <article className="min-w-0 lg:col-span-8 lg:col-start-5">
            <div className="mb-10 lg:hidden">
              <Toc items={TOC} />
            </div>

            <H2 id="overview" no="01">
              Overview
            </H2>
            <P>Fee Router is a payment layer between on-chain communities and fundraisers that do not accept crypto. A community points a token&rsquo;s creator fees at an Impact Vault. The vault sweeps those fees to USDC, delivers them to the fundraiser through a rail the fundraiser already accepts, and publishes a receipt for every delivery. The receipt is hashed and the hash is anchored on Solana so it can be verified by anyone, forever, without trusting Fee Router.</P>
            <P>Nothing about this requires the fundraiser to know what a token is. The organizer sees a donation on their page, the same as any other. The community sees a public ledger of where every dollar went.</P>
            <Table
              head={["Object", "What it is"]}
              rows={[
                ["Cause", "A fundraiser: its platform, URL, beneficiary, and verification status."],
                ["Vault", "A USDC treasury tied to exactly one cause. Owns one or more tokens' fee routes."],
                ["Token", "A launched token whose creator fees are routed, in whole or in part, to a vault."],
                ["Fee event", "One creator-fee payment observed on-chain, attributed to a token by its route address."],
                ["Sweep", "A swap of accumulated fee assets (SOL, the token) into USDC in the vault treasury."],
                ["Delivery", "One payment from the vault to the cause over a rail, with the receipt that proves it."],
                ["Receipt", "Canonical JSON for a delivery, its SHA-256, and the Solana memo transaction anchoring that hash."],
              ]}
            />

            <H2 id="fee-routing" no="02">
              Fee routing
            </H2>
            <P>Attribution is done at the address level. Every token connected to a vault gets its own route address: a fresh keypair whose secret is held by Fee Router and whose public key is the only place the token&rsquo;s creator fees should land. Because the route address is unique per token, any SOL arriving there is that token&rsquo;s revenue with no further inference.</P>
            <H3>Launched through Fee Router (pump.fun)</H3>
            <P>Tokens launched from /launch are created on pump.fun with the vault&rsquo;s route address as the token&rsquo;s creator wallet: the route key signs the create transaction and pays the dev buy. pump.fun pays creator fees to the creator wallet, so 100% of them accrue to the route address from the first trade with no redirect step and nothing the creator can change later. The create transaction is the route proof and the route is locked from block one. $ROUTE itself will launch the same way, with the protocol treasury as its creator; it has not launched yet.</P>
            <H3>Connected pump.fun tokens</H3>
            <P>For a token that already exists, pump.fun creator fees pay to the creator&rsquo;s wallet, and the creator can redirect them exactly once. Connecting it means submitting that one-time redirect to the token&rsquo;s route address. The redirect transaction is recorded as the route proof and the route is marked locked. Because it cannot be changed again, a locked pump.fun route is as strong a commitment as a launch: 100% of creator fees, permanently.</P>
            <H3>Bags</H3>
            <P>Bags supports fee-share configurations with up to 100 claimers, each assigned a share in basis points. Connecting a Bags token means adding the route address as a claimer with a stated share. Fee Router records the share as the token&rsquo;s route bps and only counts fees actually received at the route address, so a 5,000 bps share claims exactly half of what the token earns.</P>
            <H3>Meteora and manual routes</H3>
            <P>Tokens on other launchpads can be connected by pointing their fee destination at a route address by whatever mechanism the launchpad offers. Where the mechanism is not on-chain-immutable, the route is shown as unlocked. Unlocked routes are eligible for delivery but not for the Commons match.</P>
            <Note>Fee Router never takes custody of a token&rsquo;s supply or the creator&rsquo;s wallet. The only thing it holds is the route address the fees are sent to.</Note>

            <H2 id="vault" no="03">
              Vault &amp; sweep
            </H2>
            <P>A vault is a custodial USDC treasury on Solana with one cause attached. Its keypair is generated at creation and stored encrypted under a KMS key; the secret is never returned by any query or API. A vault has two policy numbers set by its owner: the donate share in basis points (how much of swept USDC must be delivered, with the remainder kept for gas and operations) and the delivery threshold in USD (deliveries queue automatically once treasury USDC crosses it).</P>
            <H3>Sweep</H3>
            <P>A worker watches every route address. When fees accumulate above a small dust threshold, they are swapped to USDC through Jupiter and sent to the vault treasury. Each sweep records the input asset and amount, the USDC received, the swap signature, and which fee events it consumed. Fee events are priced in USD at block time so the ledger totals do not move with the market afterwards.</P>
            <Ul items={["A fee event belongs to exactly one sweep once swept, and to exactly one token always.", "Sweep slippage is real and shown: the USDC received is what gets delivered, not the USD value at fee time.", "Treasury balance is read from chain; the ledger is a record, not a source of funds."]} />

            <H2 id="rails" no="04">
              Delivery rails
            </H2>
            <P>A rail is how USDC becomes a payment the fundraiser can receive. The honest version of the situation is this: consumer fundraising platforms such as GoFundMe, LaunchGood, and JustGiving do not have a donation API. Automating their checkout with a script or browser bot violates their terms of service and puts the campaign at risk of being frozen. Fee Router does not do that.</P>
            <H3>Operator card (live)</H3>
            <P>Vault USDC funds a top-up to a Zentro card. A named operator with the operator role makes the donation on the fundraiser&rsquo;s own page with that card, then attaches the confirmation (email, page screenshot, card statement line) as artifacts. The operator signs off in the operator desk; the delivery is finalized with the card reference, fiat amount, FX rate, and any platform fee. The operator&rsquo;s user id is part of the receipt.</P>
            <P>This is a human step by design. It is auditable rather than automatic. Each artifact is stored by hash, so evidence cannot be substituted after the receipt is anchored.</P>
            <H3>On-chain USDC (live)</H3>
            <P>When a cause holds a Solana address, delivery is one USDC transfer from the vault treasury to that address. The transfer signature is the rail reference. No FX, no platform fee, no operator in the loop beyond finalizing the receipt.</P>
            <H3>Issuing card (in integration)</H3>
            <P>For platforms whose terms permit programmatic card donations, a virtual card can be issued per vault through Rain or Bridge and funded directly from USDC. This removes the operator from execution. It has not been used for any delivery yet and is shown as in integration until it has.</P>
            <H3>GoFundMe Pro (nonprofits only)</H3>
            <P>Registered nonprofits on GoFundMe Pro can authorize Fee Router via OAuth, after which donations are posted through the official API with the receipt id in the donation memo. Personal campaigns cannot use this rail.</P>
            <Table
              head={["Rail", "Executed by", "Rail reference", "Status"]}
              rows={[
                ["operator_card", "Operator", "Card last 4 + authorization code", "live"],
                ["onchain", "Worker", "USDC transfer signature", "live"],
                ["issuing_card", "Worker", "Card authorization id", "in integration"],
                ["gofundme_pro", "Worker", "Donation id", "nonprofits"],
                ["stripe_link", "Worker", "Stripe payment id", "when a cause provides one"],
              ]}
            />

            <H2 id="receipt" no="05">
              Receipt spec
            </H2>
            <P>A receipt is the canonical JSON for a delivery. It is built once at finalize time, hashed with SHA-256, and the hash is written into a Solana memo. The canonical form is deterministic: keys sorted at every level, no whitespace, nulls preserved, timestamps as ISO 8601 strings in UTC. Delivery status is deliberately excluded so the bytes never change once the delivery is delivered.</P>
            <Code title="canonical receipt, shown with whitespace for reading">{CANONICAL_EXAMPLE}</Code>
            <Table
              head={["Field", "Meaning"]}
              rows={[
                ["v", "Receipt format version. Always 1 today."],
                ["id · ordinal", "Delivery id, and the per-vault sequential number printed as RCP-0004."],
                ["vault · cause", "Identity of the vault and cause at finalize time, including the cause URL."],
                ["amountUsdc", "USDC leaving the treasury for this delivery."],
                ["amountFiat · fiatCurrency · fxRate", "What the fundraiser received in its currency, and the rate applied. Null on on-chain deliveries."],
                ["platformFeeFiat", "Fee taken by the fundraising platform or card network, if any."],
                ["rail · railRef · fundingTxSig", "Which rail, its reference, and the USDC transfer that funded it."],
                ["allocations", "How much of the delivery each token funded, pro-rata by undelivered fees. Sorted by tokenId. Sums to amountUsdc."],
                ["artifacts", "Evidence files by kind, label, SHA-256, and size. Sorted by sha256. Files live in object storage; only the hashes are canonical."],
                ["period", "Reporting window the delivery closes, if any."],
                ["deliveredAt", "When the rail confirmed the payment."],
              ]}
            />
            <H3>Hash and memo</H3>
            <P>
              <code className="font-mono text-[13px]">hash = sha256(canonical)</code>, hex encoded. The memo transaction carries <code className="font-mono text-[13px]">{MEMO_PREFIX}&lt;deliveryId&gt;:&lt;hash&gt;</code> through the Solana Memo program and is signed by the vault treasury key, so the anchor is attributable to the vault that made the delivery.
            </P>

            <H2 id="verify" no="06">
              Verification
            </H2>
            <P>Every receipt page shows the canonical string, the stored hash, and the anchor signature, and recomputes the hash in front of you. You do not have to trust that page. Recompute it yourself from the public export:</P>
            <Code title="shell">{VERIFY_SNIPPET}</Code>
            <Ul items={["If the recomputed hash matches the stored hash, the receipt content has not changed since finalize.", "If the on-chain memo carries the same hash, the receipt existed at that block time and was signed by the vault treasury.", "If an artifact's hash matches the file you were shown, that file is the evidence the operator attached.", <>The verify endpoint <code className="font-mono text-[13px]">GET /api/receipts/&lt;id&gt;/verify</code> does the same three checks and returns them as JSON.</>]} />
            <Note>A receipt proves that a specific payment was recorded, hashed, and anchored. It does not prove the fundraiser spent the money well. Verification of the cause itself is a human process and is stated as such on every cause page.</Note>

            <H2 id="periods" no="07">
              Periods
            </H2>
            <P>Vaults report in weekly periods. A period records fees in and USDC delivered out for its window. Deliveries reference the period they close, so a vault page can show, for any week, what came in, what went out, and the receipts behind it. Periods do not change accounting; they are the reading frame.</P>

            <H2 id="roles" no="08">
              Roles
            </H2>
            <Table
              head={["Role", "Can", "Cannot"]}
              rows={[
                ["Owner", "Create a vault, connect tokens, set the donate share and delivery threshold, pause the vault.", "Move treasury USDC anywhere except to the cause through a rail. Edit or delete receipts."],
                ["Operator", "Execute operator-card deliveries, attach artifacts, finalize receipts, verify causes.", "Change vault policy. Finalize a delivery without a rail reference and at least one artifact."],
                ["Admin", "Grant the operator role, rotate the KMS key, retire rails.", "Alter a finalized receipt. The hash is on-chain; an edit is visible."],
              ]}
            />
            <P>Sign-in is Google, directly. Each account gets a custodial Solana wallet whose key is held encrypted by Fee Router. The operator role is granted by email allow-list and is shown on the operator&rsquo;s public profile on every receipt they finalize.</P>

            <H2 id="faq" no="09">
              FAQ
            </H2>
            {[
              ["Does the fundraiser need to do anything?", "No. The donation arrives on their page like any other. Organizers who want to can link their page to the vault so the receipt shows on both sides."],
              ["Why is a person making the card payment?", "Because the platforms these families use have no API and forbid automation. A named operator with hash-anchored evidence is the honest option. Where a platform permits programmatic donations, the issuing-card rail removes the operator."],
              ["Who pays the platform fee?", "The fundraising platform or card network takes its fee from the donation as it would for anyone. The receipt records it as platformFeeFiat so the net amount is explicit."],
              ["What happens to the part of fees that is not donated?", "The donate share is set per vault and shown on its page. The remainder stays in the treasury for swap and delivery gas. Nothing leaves a vault except through a rail to its cause."],
              ["Can a receipt be edited?", "No. Its hash is on-chain. A correction is a new delivery, or a reversal, with its own receipt that references the original."],
              ["Is $ROUTE required?", "No. Any token on a supported launchpad can route fees to a vault. The Commons vault matches deliveries for tokens launched under the three rules."],
            ].map(([q, a]) => (
              <details key={q} className="group mt-3 max-w-[68ch] hairline rounded-lg">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-[15px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
                  {q}
                  <span className="font-mono text-[14px] text-muted transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="px-4 pb-4 text-[14.5px] leading-relaxed text-ink-2">{a}</p>
              </details>
            ))}

            <div className="mt-14 flex flex-wrap gap-x-8 gap-y-3 hairline-t pt-6 font-mono text-[12px]">
              <Link href="/explore" className="hit underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                Explore vaults →
              </Link>
            </div>
          </article>
        </Container>
      </main>
      <Footer />
    </>
  );
}
