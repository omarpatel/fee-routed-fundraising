import { describe, expect, it } from "vitest";
import { badgeText, vaultBadgeSvg } from "@/lib/badge";

describe("vaultBadgeSvg", () => {
  it("escapes a hostile token symbol, since the badge is served from our origin", () => {
    const svg = vaultBadgeSvg({ deliveredUsd: 10, deliveryCount: 1, symbols: ['<b x="1">&'] });
    expect(svg).not.toMatch(/<b[\s>]/);
    expect(svg).not.toContain('x="1"');
    expect(svg).toContain("$&lt;b x=&quot;1&quot;&gt;&amp; · $10 delivered");
  });

  it("names the one funding token, counts several, and grows with the text", () => {
    expect(badgeText({ deliveredUsd: 4210.4, deliveryCount: 3, symbols: ["CURE"] })).toBe("$CURE · $4,210 delivered · 3 receipts");
    expect(badgeText({ deliveredUsd: 0, deliveryCount: 1, symbols: ["A", "B"] })).toBe("2 tokens · $0 delivered · 1 receipt");
    expect(badgeText({ deliveredUsd: 0, deliveryCount: 0, symbols: [] })).toBe("$0 delivered · 0 receipts");
    const [wide, narrow] = [vaultBadgeSvg({ deliveredUsd: 1_000_000, deliveryCount: 120, symbols: ["LONGSYMBOL"] }), vaultBadgeSvg({ deliveredUsd: 1, deliveryCount: 1, symbols: [] })].map((s) => Number(/width="(\d+)"/.exec(s)![1]));
    expect(wide).toBeGreaterThan(narrow);
  });
});
