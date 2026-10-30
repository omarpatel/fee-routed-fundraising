/* Client-side helper for the Backend's JSON envelope: { ok: true, data } | { ok: false, error }. */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  let body = rest.body;
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: json !== undefined || body ? "POST" : "GET", ...rest, headers, body, credentials: "include" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
  const text = await res.text();
  if (!text) return res.ok ? { ok: false, error: `Empty response (${res.status})` } : { ok: false, error: `${res.status} ${res.statusText}` };
  try {
    const parsed = JSON.parse(text) as ApiResult<T>;
    if (typeof parsed === "object" && parsed && "ok" in parsed) return parsed;
    return { ok: false, error: `Unexpected response (${res.status})` };
  } catch {
    return { ok: false, error: res.status === 404 ? `Route not found: ${path}` : `${res.status}: ${text.slice(0, 160)}` };
  }
}

export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
