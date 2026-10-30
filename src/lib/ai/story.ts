import { z } from "zod";
import { structured } from "./claude";

/**
 * "Suggest edits" on the fundraiser story: a cleaned-up version the organizer may accept or ignore,
 * plus the factual claims an operator should confirm before verifying. Nothing is saved here; the
 * client shows before/after and the organizer decides.
 */

export const PolishedStorySchema = z.object({
  polished: z.string().min(1),
  /** What changed, in the organizer's terms. */
  changes: z.array(z.string()).max(8),
  /** Concrete, checkable claims found in the story (amounts, dates, diagnoses, institutions, names). */
  claimsToConfirm: z.array(z.string()).max(10),
});
export type PolishedStory = z.infer<typeof PolishedStorySchema>;

const SYSTEM = `You edit fundraiser stories for Fee Router, a service that delivers money to online fundraisers and publishes a receipt for every delivery. Organizers write in a hurry and often in a second language.

Rules:
- Keep every fact exactly as written: amounts, dates, names, diagnoses, places. Never add a fact, a promise, or an emotional appeal that is not already there.
- Fix grammar, spelling and structure. Prefer short sentences and plain words. Remove exclamation marks and emoji. Do not add headings.
- Keep the organizer's voice and first person. Do not make it sound like marketing copy.
- Keep roughly the same length (never more than 20% longer).
- "claimsToConfirm" lists the specific factual claims a reviewer would want to verify against the fundraiser page or documents: each as one short line, quoting the story's own words where useful.
- "changes" lists what you changed, briefly, so the organizer can judge whether to accept.`;

const TOOL_SCHEMA = {
  properties: {
    polished: { type: "string" },
    changes: { type: "array", items: { type: "string" }, maxItems: 8 },
    claimsToConfirm: { type: "array", items: { type: "string" }, maxItems: 10 },
  },
  required: ["polished", "changes", "claimsToConfirm"],
};

export async function polishStory(text: string): Promise<PolishedStory> {
  const trimmed = text.trim();
  if (trimmed.length < 20) throw new Error("Story is too short to edit");
  return structured<PolishedStory>({
    system: SYSTEM,
    user: `## Story as written\n${trimmed.slice(0, 20_000)}`,
    tool: { name: "suggest_story_edits", description: "Return the edited story, the list of changes, and the claims to confirm.", inputSchema: TOOL_SCHEMA },
    parse: PolishedStorySchema,
    maxTokens: 4096,
  });
}
