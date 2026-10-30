import { NextResponse } from "next/server";
import { fail, route } from "@/app/api/_lib";
import { readArtifact } from "@/lib/ledger/artifacts";

/** Public, immutable: the URL embeds the content hash. */
export const GET = route<{ deliveryId: string; sha256: string }>(async (_req, { deliveryId, sha256 }) => {
  const a = await readArtifact(deliveryId, sha256.toLowerCase());
  if (!a) return fail("Artifact not found", 404);
  return new NextResponse(new Uint8Array(a.body), { headers: { "content-type": a.mime, "content-length": String(a.bytes), "cache-control": "public, max-age=31536000, immutable", "x-content-sha256": sha256.toLowerCase() } });
});
