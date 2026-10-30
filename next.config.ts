import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    /** Client-visible "is Google sign-in set up" flag; the secrets themselves stay server-side. */
    NEXT_PUBLIC_GOOGLE_AUTH_CONFIGURED: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.SESSION_SECRET ? "1" : "0",
  },
  async rewrites() {
    return [
      { source: "/privacy", destination: "/legal/privacy" },
      { source: "/terms", destination: "/legal/terms" },
    ];
  },
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      // Receipts may be embedded by our own pages (OG previews, share cards); everything else is never framed.
      { source: "/r/:path*", headers: [...base, { key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/((?!r/).*)", headers: [...base, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
