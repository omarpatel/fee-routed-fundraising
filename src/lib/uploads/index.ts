import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { dataDir } from "@/lib/env";

/**
 * User-supplied pictures (token image, cause cover, avatar). Decoded and re-encoded with sharp so
 * only real raster bytes ever land on disk; content-addressed at `<dataDir>/uploads/images/<sha256>.<ext>`
 * and served by GET /api/files/images/[name]. No picture is ever taken from a URL.
 */
const ROOT = path.join(dataDir, "uploads", "images");
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_URL_PREFIX = "/api/files/images/";
export const IMAGE_KINDS = ["token", "cause", "avatar"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

const ACCEPTED_MIME: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true };
const MIME_BY_EXT: Record<string, string> = { png: "image/png", webp: "image/webp" };
const NAME_RE = /^([0-9a-f]{64})\.(png|webp)$/;

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export interface StoredImage {
  /** sha256 of the stored (normalised) bytes. */
  id: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

/** Per-kind normalisation: tokens are square PNGs (launchpad metadata), covers are wide WEBP, avatars small square WEBP. */
const SHAPE: Record<ImageKind, { ext: "png" | "webp"; fit: "cover" | "inside"; width: number; height?: number }> = {
  token: { ext: "png", fit: "cover", width: 1024, height: 1024 },
  cause: { ext: "webp", fit: "inside", width: 1600 },
  avatar: { ext: "webp", fit: "cover", width: 512, height: 512 },
};

/** True when `url` is one of ours (relative form only; hosts are never trusted). */
export function isStoredImageUrl(url: string): boolean {
  return url.startsWith(IMAGE_URL_PREFIX) && NAME_RE.test(url.slice(IMAGE_URL_PREFIX.length));
}

/** Validate, decode, normalise, persist. Idempotent on normalised content. */
export async function storeImage(file: File | Blob, kind: ImageKind): Promise<StoredImage> {
  if (!SHAPE[kind]) throw new UploadError(`Unknown image kind: ${String(kind)}`);
  if (file.size === 0) throw new UploadError("Empty file");
  if (file.size > IMAGE_MAX_BYTES) throw new UploadError(`Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024} MB`, 413);
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_MIME[type]) throw new UploadError(`Unsupported image type "${type || "unknown"}"; upload a PNG, JPG or WEBP`, 415);
  const input = Buffer.from(await file.arrayBuffer());
  return storeImageBytes(input, kind);
}

export async function storeImageBytes(input: Buffer, kind: ImageKind): Promise<StoredImage> {
  const shape = SHAPE[kind];
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 64e6 }).metadata();
  } catch (e) {
    throw new UploadError(`Not a decodable image: ${e instanceof Error ? e.message : String(e)}`, 415);
  }
  if (!meta.format || !["png", "jpeg", "webp"].includes(meta.format)) throw new UploadError(`Not a PNG, JPG or WEBP image (decoded as ${meta.format ?? "unknown"})`, 415);
  if (!meta.width || !meta.height) throw new UploadError("Image has no dimensions", 415);

  // Rotate per EXIF, drop metadata, resize (never upscale), flatten alpha onto paper for JPEG-origin covers.
  let pipeline = sharp(input, { limitInputPixels: 64e6 }).rotate().resize({ width: shape.width, height: shape.height, fit: shape.fit, withoutEnlargement: true, position: "attention" });
  pipeline = shape.ext === "png" ? pipeline.png({ compressionLevel: 9, palette: false }) : pipeline.webp({ quality: 86 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const id = createHash("sha256").update(data).digest("hex");
  const name = `${id}.${shape.ext}`;
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, name), data);
  return { id, url: `${IMAGE_URL_PREFIX}${name}`, width: info.width, height: info.height, bytes: data.length, mime: MIME_BY_EXT[shape.ext] };
}

export interface ImageBytes {
  body: Buffer;
  mime: string;
  bytes: number;
  ext: string;
}

/** Bytes of a stored image by its public name, for serving and for launchpad metadata uploads. */
export async function readImage(name: string): Promise<ImageBytes | null> {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const p = path.join(ROOT, name);
  try {
    const s = await stat(p);
    if (!s.isFile()) return null;
    return { body: await readFile(p), mime: MIME_BY_EXT[m[2]], bytes: s.size, ext: m[2] };
  } catch {
    return null;
  }
}

/** Resolve a stored image URL (as sent back by the client) to its bytes; throws when it is not one of ours. */
export async function readImageByUrl(url: string): Promise<ImageBytes> {
  if (!isStoredImageUrl(url)) throw new UploadError("Image must be uploaded through /api/uploads first");
  const img = await readImage(url.slice(IMAGE_URL_PREFIX.length));
  if (!img) throw new UploadError("Uploaded image no longer exists; upload it again", 404);
  return img;
}
