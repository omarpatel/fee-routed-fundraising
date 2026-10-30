import type { Rail } from "@/lib/db/schema";

/** Short, honest rail names for tickers and receipts. */
export const RAIL_LABEL: Record<Rail, string> = {
  operator_card: "card",
  issuing_card: "card",
  onchain: "on-chain USDC",
  stripe_link: "Stripe",
  gofundme_pro: "GoFundMe Pro",
};

export const RAIL_DESCRIPTION: Record<Rail, string> = {
  operator_card: "Operator-executed card payment on the fundraiser's own page",
  issuing_card: "Issued card, funded from vault USDC",
  onchain: "Direct USDC transfer to the cause's wallet",
  stripe_link: "Stripe payment link",
  gofundme_pro: "GoFundMe Pro API donation",
};
