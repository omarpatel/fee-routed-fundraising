import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { configured, env } from "@/lib/env";

/**
 * Claude is assistive only. Every caller renders its output as a suggestion for a human; nothing
 * here approves, rejects, finalizes or moves money. Absent `ANTHROPIC_API_KEY` the client throws a
 * specific error the API surfaces verbatim.
 */
export const AI_NOT_CONFIGURED = "Claude not configured: set ANTHROPIC_API_KEY in .env";

export class AiNotConfiguredError extends Error {
  readonly status = 503;
  constructor() {
    super(AI_NOT_CONFIGURED);
    this.name = "AiNotConfiguredError";
  }
}

let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!configured.claude) throw new AiNotConfiguredError();
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  return client;
}

export function claudeModel(): string {
  return env.ANTHROPIC_MODEL;
}

export interface StructuredCall<T> {
  system: string;
  user: string;
  /** Tool name + description Claude sees; the JSON schema is what it must fill in. */
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  /** Runtime validation of what came back; a Zod schema mirroring `inputSchema`. */
  parse: ZodType<T>;
  maxTokens?: number;
}

/**
 * Forced tool use = structured output: Claude must call `tool` exactly once with JSON matching
 * `inputSchema`; the result is re-validated with Zod before anyone trusts it.
 */
export async function structured<T>(call: StructuredCall<T>): Promise<T> {
  const res = await claude().messages.create({
    model: claudeModel(),
    max_tokens: call.maxTokens ?? 2048,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    tools: [{ name: call.tool.name, description: call.tool.description, input_schema: { type: "object", ...call.tool.inputSchema } as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: call.tool.name },
  });
  const use = res.content.find((c) => c.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error(`Claude returned no ${call.tool.name} call (stop_reason ${res.stop_reason})`);
  return call.parse.parse(use.input);
}
