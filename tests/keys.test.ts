import { Keypair } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { keys } from "@/lib/db/schema";
import { anchorSignerAddress, decryptSecret, encryptSecret, ensureAnchorSigner, generateKey, hasKey, loadKeypair } from "@/lib/keys";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips bytes and never stores them in the clear", () => {
    const secret = randomBytes(64);
    const enc = encryptSecret(secret);
    expect(enc.split(":")).toHaveLength(3);
    expect(enc).not.toContain(secret.toString("base64"));
    expect(Buffer.from(decryptSecret(enc))).toEqual(secret);
    // Fresh IV each time: identical plaintexts encrypt differently.
    expect(encryptSecret(secret)).not.toBe(enc);
  });

  it("rejects ciphertext or tag tampering", () => {
    const enc = encryptSecret(randomBytes(32));
    const [iv, tag, ct] = enc.split(":");
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[0] ^= 0x01;
      return b.toString("base64");
    };
    expect(() => decryptSecret(`${iv}:${tag}:${flip(ct)}`)).toThrow();
    expect(() => decryptSecret(`${iv}:${flip(tag)}:${ct}`)).toThrow();
    expect(() => decryptSecret("not:enough")).toThrow(/Malformed/);
  });

  it("fails under a different KMS key, and refuses without one", async () => {
    // `env` is parsed once at import; a fresh module instance is the only way to observe another key.
    const enc = encryptSecret(randomBytes(32));
    const original = process.env.FEE_ROUTER_KMS_KEY;

    process.env.FEE_ROUTER_KMS_KEY = "a1".repeat(32);
    vi.resetModules();
    const other = await import("@/lib/keys");
    expect(() => other.decryptSecret(enc)).toThrow();

    delete process.env.FEE_ROUTER_KMS_KEY;
    vi.resetModules();
    const none = await import("@/lib/keys");
    expect(() => none.decryptSecret(enc)).toThrow(expect.objectContaining({ name: "KmsNotConfiguredError" }));
    expect(() => none.encryptSecret(randomBytes(1))).toThrow(expect.objectContaining({ name: "KmsNotConfiguredError" }));

    process.env.FEE_ROUTER_KMS_KEY = original;
    vi.resetModules();
  });
});

describe("custodial keys in the ledger", () => {
  it("generateKey persists only the address and an encrypted secret; loadKeypair reconstructs the signer", async () => {
    const { address } = await generateKey("vault_treasury", "vlt_x");
    const row = (await db.select().from(keys).where(eq(keys.address, address)).get())!;
    expect(row.purpose).toBe("vault_treasury");
    expect(row.ownerId).toBe("vlt_x");
    expect(row.secretEnc.split(":")).toHaveLength(3);

    const kp = await loadKeypair(address);
    expect(kp.publicKey.toBase58()).toBe(address);
    expect(Keypair.fromSecretKey(decryptSecret(row.secretEnc)).publicKey.toBase58()).toBe(address);
    expect(await hasKey(address)).toBe(true);
    expect(await hasKey(Keypair.generate().publicKey.toBase58())).toBe(false);
    await expect(loadKeypair(Keypair.generate().publicKey.toBase58())).rejects.toThrow(/No custodial key/);
  });

  it("ensureAnchorSigner creates one signer and then always returns it", async () => {
    expect(await anchorSignerAddress()).toBeNull();
    const a = await ensureAnchorSigner();
    expect(await ensureAnchorSigner()).toBe(a);
    expect(await anchorSignerAddress()).toBe(a);
    expect((await db.select().from(keys).where(eq(keys.purpose, "anchor_signer"))).length).toBe(1);
  });
});
