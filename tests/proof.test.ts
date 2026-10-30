import { describe, expect, it } from "vitest";
import { canonicalReceipt, memoFor, parseMemo, receiptHash, toCanonicalObject, verifyReceipt } from "@/lib/proof";
import { receiptFixture } from "./fixtures";

/** Every object in the tree has its keys in sorted order — the property a third-party verifier relies on. */
function keysSorted(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(keysSorted);
  if (value && typeof value === "object") {
    const ks = Object.keys(value);
    return ks.every((k, i) => (i === 0 || ks[i - 1] < k) && keysSorted((value as Record<string, unknown>)[k]));
  }
  return true;
}

describe("canonicalReceipt", () => {
  it("is key-sorted at every depth and has no formatting whitespace (stringify(parse(c)) === c)", () => {
    const c = canonicalReceipt(receiptFixture());
    expect(keysSorted(JSON.parse(c))).toBe(true);
    expect(JSON.stringify(JSON.parse(c))).toBe(c);
  });

  it("is independent of delivery status and of the stored hash/anchor, so it stays recomputable forever", () => {
    const base = canonicalReceipt(receiptFixture());
    for (const status of ["queued", "funded", "executing", "delivered", "failed", "reversed"] as const) {
      expect(canonicalReceipt(receiptFixture({ delivery: { status, receiptHash: "f".repeat(64), anchorTxSig: "sig" } }))).toBe(base);
    }
  });

  it("orders allocations by tokenId and artifacts by sha256 regardless of input order", () => {
    const r = receiptFixture();
    const reversed = receiptFixture({ allocations: [...r.allocations].reverse(), artifacts: [...r.artifacts].reverse() });
    expect(canonicalReceipt(reversed)).toBe(canonicalReceipt(r));
    const obj = toCanonicalObject(r);
    expect(obj.allocations.map((a) => a.tokenId)).toEqual(["tok_a", "tok_b"]);
    expect(obj.artifacts.map((a) => a.sha256[0])).toEqual(["a", "b"]);
  });

  it("changes when money facts change", () => {
    const base = canonicalReceipt(receiptFixture());
    expect(canonicalReceipt(receiptFixture({ delivery: { amountUsdc: 100.01 } }))).not.toBe(base);
    expect(canonicalReceipt(receiptFixture({ delivery: { railRef: "0000/other" } }))).not.toBe(base);
    expect(canonicalReceipt(receiptFixture({ period: null }))).not.toBe(base);
  });

  it("preserves nulls and encodes dates as ISO-8601 UTC", () => {
    const obj = toCanonicalObject(receiptFixture({ delivery: { platformFeeFiat: null, deliveredAt: new Date(Date.UTC(2026, 0, 5, 13)) } }));
    expect(obj.platformFeeFiat).toBeNull();
    expect(obj.deliveredAt).toBe("2026-01-05T13:00:00.000Z");
    expect(obj.period?.endsAt).toBe("2026-01-09T00:00:00.000Z");
  });
});

describe("receiptHash", () => {
  it("is the lowercase hex sha256 of the canonical bytes and is deterministic", () => {
    const c = canonicalReceipt(receiptFixture());
    const h = receiptHash(c);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHash(canonicalReceipt(receiptFixture()))).toBe(h);
    expect(receiptHash(c + " ")).not.toBe(h);
  });
});

describe("verifyReceipt", () => {
  const sealed = () => {
    const r = receiptFixture();
    r.delivery.receiptHash = receiptHash(canonicalReceipt(r));
    r.delivery.anchorTxSig = "anchorSig";
    return r;
  };

  it("verifies an untampered sealed receipt", () => {
    const v = verifyReceipt(sealed());
    expect(v.ok).toBe(true);
    expect(v.anchoredHash).toBe(v.computedHash);
    expect(v.anchorTxSig).toBe("anchorSig");
  });

  it("fails when the amount was edited after sealing", () => {
    const r = sealed();
    r.delivery.amountUsdc = 99.99;
    const v = verifyReceipt(r);
    expect(v.ok).toBe(false);
    expect(v.computedHash).not.toBe(v.anchoredHash);
  });

  it("fails when an allocation was edited after sealing", () => {
    const r = sealed();
    r.allocations[0].amountUsdc += 0.01;
    expect(verifyReceipt(r).ok).toBe(false);
  });

  it("fails when no hash was stored (unsealed delivery)", () => {
    const r = receiptFixture();
    const v = verifyReceipt(r);
    expect(v.ok).toBe(false);
    expect(v.anchoredHash).toBeNull();
    expect(v.computedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails when the stored hash belongs to a different receipt", () => {
    const other = receiptHash(canonicalReceipt(receiptFixture({ delivery: { id: "dlv_0002", ordinal: 2 } })));
    const r = receiptFixture({ delivery: { receiptHash: other } });
    expect(verifyReceipt(r).ok).toBe(false);
  });
});

describe("memo", () => {
  const hash = receiptHash("x");

  it("round-trips ids containing colons", () => {
    const memo = memoFor("dlv:with:colons", hash);
    expect(memo).toBe(`fee-router:v1:dlv:with:colons:${hash}`);
    expect(parseMemo(memo)).toEqual({ id: "dlv:with:colons", hash });
  });

  it("rejects memos that are not ours", () => {
    expect(parseMemo("hello")).toBeNull();
    expect(parseMemo("fee-router:v2:dlv_1:" + hash)).toBeNull();
    expect(parseMemo(`fee-router:v1:${hash}`)).toBeNull();
    expect(parseMemo("fee-router:v1:dlv_1:" + hash.slice(0, 63))).toBeNull();
    expect(parseMemo("fee-router:v1:dlv_1:" + hash.toUpperCase())).toBeNull();
  });
});
