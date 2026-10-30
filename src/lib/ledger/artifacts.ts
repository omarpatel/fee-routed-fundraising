import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";

/** Evidence store: `<dataDir>/uploads/<deliveryId>/<sha256>.<ext>`. Only the hash is canonical. */
const ROOT = path.join(dataDir, "uploads");
const MAX_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  eml: "message/rfc822",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
};
const ALLOWED_EXT: Record<string, true> = { png: true, jpg: true, jpeg: true, webp: true, gif: true, pdf: true, txt: true, eml: true, csv: true, json: true };

export class ArtifactError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export function extensionOf(filename: string, mime: string | null): string {
  const fromName = filename.toLowerCase().split(".").pop() ?? "";
  if (ALLOWED_EXT[fromName]) return fromName;
  const fromMime = Object.entries(MIME_BY_EXT).find(([, m]) => m.split(";")[0] === mime)?.[0];
  if (fromMime) return fromMime;
  throw new ArtifactError(`Unsupported file type: ${mime ?? filename}`);
}

export interface StoredArtifact {
  sha256: string;
  bytes: number;
  ext: string;
  /** Public URL served by GET /api/artifacts/[deliveryId]/[sha256]. */
  url: string;
}

/** Hash, compare with the client's claim, persist. Idempotent on content. */
export async function storeArtifact(deliveryId: string, file: File, claimedSha256: string): Promise<StoredArtifact> {
  if (file.size === 0) throw new ArtifactError("Empty file");
  if (file.size > MAX_BYTES) throw new ArtifactError(`File exceeds ${MAX_BYTES / 1024 / 1024} MB`, 413);
  const ext = extensionOf(file.name, file.type || null);
  const buf = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (sha256 !== claimedSha256.toLowerCase()) throw new ArtifactError(`sha256 mismatch: client sent ${claimedSha256.slice(0, 12)}…, file hashes to ${sha256.slice(0, 12)}…`);
  return storeBuffer(deliveryId, buf, ext);
}

/** Persist system-generated evidence (card statement JSON, harvested .eml). Idempotent on content. */
export async function storeBuffer(deliveryId: string, buf: Buffer, ext: string): Promise<StoredArtifact> {
  if (buf.length === 0) throw new ArtifactError("Empty file");
  if (buf.length > MAX_BYTES) throw new ArtifactError(`File exceeds ${MAX_BYTES / 1024 / 1024} MB`, 413);
  if (!/^[a-zA-Z0-9_-]+$/.test(deliveryId)) throw new ArtifactError("Bad delivery id");
  if (!ALLOWED_EXT[ext]) throw new ArtifactError(`Unsupported file type: ${ext}`);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dir = path.join(ROOT, deliveryId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sha256}.${ext}`), buf);
  return { sha256, bytes: buf.length, ext, url: `/api/artifacts/${deliveryId}/${sha256}` };
}

/** Stable bytes for hashed evidence: keys sorted at every level, no whitespace, Dates as ISO. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = sort(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Locate a stored artifact by hash (extension unknown to the URL). */
export async function readArtifact(deliveryId: string, sha256: string): Promise<{ body: Buffer; mime: string; bytes: number } | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(deliveryId) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const dir = path.join(ROOT, deliveryId);
  for (const ext of Object.keys(ALLOWED_EXT)) {
    const p = path.join(dir, `${sha256}.${ext}`);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      return { body: await readFile(p), mime: MIME_BY_EXT[ext], bytes: s.size };
    } catch {
      continue;
    }
  }
  return null;
}
