import { NextResponse } from "next/server";
import { fail, route } from "@/app/api/_lib";
import { readImage } from "@/lib/uploads";

/** Public, immutable: the name is `<sha256>.<png|webp>`; anything else is rejected by `readImage`. */
export const GET = route<{ name: string }>(async (_req, { name }) => {
  const img = await readImage(name);
  if (!img) return fail("Image not found", 404);
  return new NextResponse(new Uint8Array(img.body), { headers: { "content-type": img.mime, "content-length": String(img.bytes), "cache-control": "public, max-age=31536000, immutable", "x-content-sha256": name.slice(0, 64) } });
});
