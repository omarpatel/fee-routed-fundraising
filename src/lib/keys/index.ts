import { Keypair } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { keys } from "@/lib/db/schema";
import { configured, env } from "@/lib/env";

export type KeyPurpose = (typeof keys.$inferSelect)["purpose"];

export class KmsNotConfiguredError extends Error {
  constructor() {
    super("FEE_ROUTER_KMS_KEY is not configured; custodial keys cannot be created or loaded. Set a 32-byte hex key.");
    this.name = "KmsNotConfiguredError";
  }
}

function kmsKey(): Buffer {
  if (!configured.kms) throw new KmsNotConfiguredError();
  return Buffer.from(env.FEE_ROUTER_KMS_KEY!, "hex");
}

/** AES-256-GCM. Stored as `iv:tag:ct`, each base64. */
export function encryptSecret(plain: Uint8Array): string {
  const key = kmsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(enc: string): Uint8Array {
  const key = kmsKey();
  const parts = enc.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted secret");
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Generate a custodial keypair, persist its encrypted secret, return only the address. */
export async function generateKey(purpose: KeyPurpose, ownerId: string): Promise<{ address: string }> {
  const kp = Keypair.generate();
  const secretEnc = encryptSecret(kp.secretKey);
  const address = kp.publicKey.toBase58();
  await db.insert(keys).values({ address, purpose, ownerId, secretEnc, createdAt: new Date() });
  return { address };
}

export async function loadKeypair(address: string): Promise<Keypair> {
  const row = await db.select().from(keys).where(eq(keys.address, address)).get();
  if (!row) throw new Error(`No custodial key for ${address}`);
  return Keypair.fromSecretKey(decryptSecret(row.secretEnc));
}

export async function hasKey(address: string): Promise<boolean> {
  const row = await db.select({ address: keys.address }).from(keys).where(eq(keys.address, address)).get();
  return !!row;
}

/** The single memo signer used to anchor receipts. Created on first use. */
export async function anchorSignerAddress(): Promise<string | null> {
  const row = await db.select({ address: keys.address }).from(keys).where(eq(keys.purpose, "anchor_signer")).get();
  return row?.address ?? null;
}

export async function ensureAnchorSigner(): Promise<string> {
  const existing = await anchorSignerAddress();
  if (existing) return existing;
  return (await generateKey("anchor_signer", "system")).address;
}
