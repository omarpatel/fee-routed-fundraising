import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Footer, Header } from "@/components/shell";
import { Container, Eyebrow } from "@/components/ui";

/**
 * /legal/privacy and /legal/terms (also served at /privacy and /terms via next.config rewrites).
 * Plain, specific, and true to how the system actually works. Not templated boilerplate.
 */

const UPDATED = "September 23, 2026";

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-10 font-display text-[28px] leading-tight">{children}</h2>;
}
function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-[70ch] text-[15px] leading-relaxed text-ink-2">{children}</p>;
}
function Ul({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-3 max-w-[70ch] list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-2">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

const PAGES: Record<string, { title: string; body: ReactNode }> = {
  privacy: {
    title: "Privacy policy",
    body: (
      <>
        <P>Fee Router is a payment layer that converts token creator fees to USDC and delivers them to fundraisers, publishing a receipt for every delivery. This policy describes what we store, why, and who can see it.</P>
        <H2>What we collect</H2>
        <Ul
          items={[
            <>
              <strong>Google sign-in.</strong> When you sign in we receive your Google account id, email address, name and profile picture from Google. We use these to create your account and show who you are. We do not receive your Google password.
            </>,
            <>
              <strong>Custodial wallet.</strong> At first sign-in we generate a Solana wallet for you and store its private key encrypted (AES-256-GCM) on our servers. Its public address, balances and transfers are visible to you in your dashboard.
            </>,
            <>
              <strong>Operator Gmail access (operators only).</strong> Operators who choose “Connect Gmail” grant read access to their mailbox and permission to send mail. We use read access only to locate donation confirmation emails that match a delivery, and send access only to notify operators about deliveries awaiting them. We store an encrypted refresh token; we do not store mailbox contents beyond the specific confirmation email attached as receipt evidence.
            </>,
            <>
              <strong>Ledger data.</strong> Fundraisers, vaults, tokens, on-chain fee events, deliveries and receipts. Most of this is public by design: it is the product.
            </>,
            <>
              <strong>Evidence files.</strong> Screenshots, confirmation emails and card statement lines attached to deliveries. Their SHA-256 hashes are public; files are served publicly from receipt pages.
            </>,
            <>
              <strong>Session and request data.</strong> Session identifiers (cookies), IP address and user agent for security.
            </>,
          ]}
        />
        <H2>What we do not do</H2>
        <Ul items={["We do not sell personal data.", "We do not use Gmail data for advertising or for anything other than receipts and operator notifications.", "We do not share your Google data with third parties except the infrastructure providers that run the service (hosting, Solana RPC), under their own data processing terms."]} />
        <H2>Google API Services</H2>
        <P>Fee Router’s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</P>
        <H2>Retention and deletion</H2>
        <P>Ledger data and receipts are permanent by design; they are the public record of where money went. Account data, sessions and Gmail tokens are deleted on request. Custodial wallets are not deleted while they hold funds; withdraw first. Email hello@example.com to request deletion.</P>
        <H2>Cookies</H2>
        <P>One session cookie (`fee_router_session`) and two ten-minute cookies used during Google sign-in. No advertising or analytics cookies.</P>
        <H2>Contact</H2>
        <P>hello@example.com</P>
      </>
    ),
  },
  terms: {
    title: "Terms of service",
    body: (
      <>
        <P>These terms govern use of example.com and the Fee Router service. By using the service you agree to them.</P>
        <H2>What Fee Router is</H2>
        <P>Fee Router routes token creator fees into a vault, converts them to USDC, and delivers them to a fundraiser through the payment rail that fundraiser already accepts (a card operated by a Fee Router operator, or a direct on-chain transfer). Every delivery is recorded and published as a receipt with a cryptographic hash anchored on Solana.</P>
        <H2>Custodial wallets</H2>
        <P>Your Fee Router wallet is held for you. We keep its key encrypted and sign transactions you request from your dashboard. You are responsible for the addresses you send to; on-chain transfers cannot be reversed. Withdrawal limits and rate limits apply. Do not use the wallet for anything unlawful.</P>
        <H2>Vaults, tokens and fee routing</H2>
        <P>Routing a token’s creator fees to a vault is your decision as the token’s creator. On some launchpads the route is permanent once set. Fee Router does not control token prices, trading, or the launchpads themselves.</P>
        <H2>Deliveries and rails</H2>
        <Ul
          items={[
            "Card deliveries are executed by a named Fee Router operator using the operator’s card, as the donor of record on the fundraiser platform, with the community shown as the display name where the platform allows it.",
            "Fee Router never automates a fundraiser platform’s checkout. Deliveries respect each platform’s terms.",
            "On-chain deliveries are transfers to the recipient address the fundraiser provided.",
            "Failed or reversed deliveries remain on the public ledger with a reason.",
          ]}
        />
        <H2>Fundraiser verification</H2>
        <P>“Verified” means a Fee Router operator confirmed the organizer’s identity and that the linked page belongs to them, and recorded a note saying how. It is not a guarantee about how the funds are used after delivery.</P>
        <H2>No fees, no advice</H2>
        <P>Fee Router takes no fee from vault flows. Nothing on the service is financial, legal or tax advice. Donations to individuals are generally not tax-deductible.</P>
        <H2>Risk</H2>
        <P>Digital assets are volatile; conversions happen at market rates with slippage. Custodial services carry counterparty risk. Third-party rails (card providers, launchpads, fundraiser platforms) can change or fail. Keep balances small.</P>
        <H2>Acceptable use</H2>
        <P>No fraud, no sanctioned jurisdictions, no fundraisers you do not control or have permission to link, no attempts to bypass verification or operator review.</P>
        <H2>Changes and contact</H2>
        <P>We may update these terms; the date above changes when we do. Questions: hello@example.com.</P>
      </>
    ),
  },
};

type Params = { params: Promise<{ page: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { page } = await params;
  const p = PAGES[page];
  return p ? { title: p.title, description: `${p.title} for Fee Router, updated ${UPDATED}. Plain and specific to how the system works.` } : { title: "Legal" };
}

export default async function LegalPage({ params }: Params) {
  const { page } = await params;
  const p = PAGES[page];
  if (!p) notFound();
  return (
    <>
      <Header />
      <main className="flex-1">
        <Container className="py-14 lg:py-20">
          <Eyebrow>Legal · updated {UPDATED}</Eyebrow>
          <h1 className="mt-3 font-display text-[44px] leading-none sm:text-[56px]">{p.title}</h1>
          <div className="mt-6 max-w-[72ch]">{p.body}</div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
