import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "@/lib/env";

describe("resolveDataDir", () => {
  it("keeps written files beside the SQLite file, so they persist on the same volume", () => {
    expect(resolveDataDir("file:/data/fee-router.db")).toBe(path.resolve("/data"));
    expect(resolveDataDir("file:./data/fee-router.db")).toBe(path.resolve("data"));
  });

  it("prefers an explicit DATA_DIR, and falls back to ./data for a remote database", () => {
    expect(resolveDataDir("file:/data/fee-router.db", "/mnt/files")).toBe(path.resolve("/mnt/files"));
    expect(resolveDataDir("libsql://fee-router.turso.io")).toBe(path.resolve("data"));
  });
});
