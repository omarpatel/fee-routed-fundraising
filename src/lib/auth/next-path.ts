/**
 * Post-login destination, restricted to a same-origin path: must start with a single `/`,
 * never `//host` or a scheme, no control characters. Anything else falls back to `/`.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  return value.length > 2048 ? "/" : value;
}
