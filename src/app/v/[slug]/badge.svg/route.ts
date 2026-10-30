import { vaultBadgeSvg } from "@/lib/badge";
import { getVaultBadge } from "@/lib/db/queries";

/**
 * Live, embeddable vault badge. Served as an image from our origin, so it carries its own CSP:
 * even opened directly, the SVG cannot run script or load anything.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const badge = await getVaultBadge((await params).slug);
  if (!badge) return new Response("Vault not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(vaultBadgeSvg(badge), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
