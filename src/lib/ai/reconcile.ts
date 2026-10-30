import { z } from "zod";
import type { Delivery } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { structured } from "./claude";

/**
 * Plain-English rationale for a card-statement match, appended to `deliveries.notes` by the
 * reconciler. Advisory: the match itself is made by `matchPurchase` (deterministic) and the receipt
 * is finalized whether or not this ran.
 */

export const MatchExplanationSchema = z.object({
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});
export type MatchExplanation = z.infer<typeof MatchExplanationSchema>;

export interface MatchedTx {
  id: string;
  merchant: string;
  amountUsd: number;
  at: Date;
}

const SYSTEM = `You write the one-paragraph rationale that goes on a Fee Router delivery receipt after the system matched a card purchase to a delivery. Two sentences, plain English, no adjectives. State what was compared (platform, amount, timing, merchant descriptor, confirmation email if any) and how well it lines up. "confidence" is your read of the match: high when platform, amount and timing all agree and an email confirms it; medium when one is missing; low when something conflicts. You do not decide anything; a human reads this on the receipt.`;

const TOOL_SCHEMA = {
  properties: {
    rationale: { type: "string", description: "Exactly two sentences." },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["rationale", "confidence"],
};

/** Null when Claude is not configured; never throws on configuration. */
export async function explainMatch(delivery: Pick<Delivery, "id" | "amountUsdc" | "fundedAt" | "rail">, platform: string, tx: MatchedTx, emailText: string | null): Promise<MatchExplanation | null> {
  if (!configured.claude) return null;
  const user = [
    "## Delivery",
    JSON.stringify({ id: delivery.id, rail: delivery.rail, amountUsdc: delivery.amountUsdc, fundedAt: delivery.fundedAt?.toISOString() ?? null, platform }, null, 2),
    "",
    "## Matched card purchase",
    JSON.stringify({ id: tx.id, merchant: tx.merchant, amountUsd: tx.amountUsd, at: tx.at.toISOString() }, null, 2),
    "",
    "## Confirmation email (text, may be absent)",
    emailText ? emailText.slice(0, 4000) : "(none found)",
  ].join("\n");
  return structured<MatchExplanation>({
    system: SYSTEM,
    user,
    tool: { name: "record_match_rationale", description: "Record the two-sentence rationale and a confidence level.", inputSchema: TOOL_SCHEMA },
    parse: MatchExplanationSchema,
    maxTokens: 400,
  });
}
