import { z } from "zod";
import { fail, ok, parseBody, rateLimiter, requireApiSession, route } from "@/app/api/_lib";
import { AiNotConfiguredError } from "@/lib/ai/claude";
import { polishStory } from "@/lib/ai/story";

const Body = z.object({ story: z.string().min(20).max(20_000) });

const RATE_MAX = 10;
/** Any Google account can sign up, and each call is a paid Claude request of up to ~9k tokens. */
const suggestions = rateLimiter(60 * 60_000, RATE_MAX);

/** Suggested edits for a fundraiser story. Session required; nothing is stored. */
export const POST = route(async (req) => {
  const { user } = await requireApiSession();
  const { story } = await parseBody(req, Body);
  if (!suggestions.take(user.id)) return fail(`At most ${RATE_MAX} story suggestions per hour`, 429);
  try {
    return ok(await polishStory(story));
  } catch (e) {
    if (e instanceof AiNotConfiguredError) return fail(e.message, e.status);
    throw e;
  }
});
