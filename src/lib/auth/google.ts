import "server-only";
import { generateCodeVerifier, generateState } from "arctic";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { googleProvider, type GoogleClientKind } from "./google-tokens";

export { GOOGLE_REDIRECT_PATH, GoogleNotConfiguredError, GoogleNotConnectedError, hasGoogleTokens, refreshAccessToken, storeRefreshToken } from "./google-tokens";

/** OIDC sign-in only. */
export const GOOGLE_BASE_SCOPES = ["openid", "email", "profile"] as const;
/** Operators: read donation confirmations, send runbook notifications. Needs a refresh token (offline consent). */
export const GOOGLE_OPERATOR_SCOPES = [...GOOGLE_BASE_SCOPES, "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"] as const;

/** Short-lived httpOnly cookies carrying the PKCE handshake across the redirect. */
export const OAUTH_STATE_COOKIE = "fee_router_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "fee_router_oauth_verifier";
const OAUTH_COOKIE_MAX_AGE = 10 * 60;

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/**
 * Google authorization URL (PKCE S256) for the given client. Gmail scopes require a refresh token,
 * so those requests add `access_type=offline&prompt=consent`; plain sign-in lets Google pick the prompt.
 */
export function googleAuthUrl(state: string, codeVerifier: string, scopes: readonly string[] = GOOGLE_BASE_SCOPES, client: GoogleClientKind = "signin"): URL {
  const url = googleProvider(client).createAuthorizationURL(state, codeVerifier, [...scopes]);
  if (scopes.some((s) => s.includes("gmail"))) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  }
  return url;
}

/** Verified ID-token claims we act on. `sub` is the stable identity; email may change. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface ExchangeResult {
  identity: GoogleIdentity;
  accessToken: string;
  /** Present only when the request asked for offline access and the user consented. */
  refreshToken: string | null;
  scopes: string[];
}

/** Redeem the code with the client that started the flow, then validate the ID token against Google's JWKS (iss + aud + exp). */
export async function exchangeCode(code: string, codeVerifier: string, client: GoogleClientKind = "signin"): Promise<ExchangeResult> {
  const tokens = await googleProvider(client).validateAuthorizationCode(code, codeVerifier);
  const audience = client === "gmail" ? env.GOOGLE_GMAIL_CLIENT_ID! : env.GOOGLE_CLIENT_ID!;
  const { payload } = await jwtVerify(tokens.idToken(), JWKS, { issuer: ISSUERS, audience });
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!payload.sub || !email) throw new Error("Google ID token is missing sub/email");
  return {
    identity: {
      sub: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
      picture: typeof payload.picture === "string" ? payload.picture : null,
    },
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    scopes: tokens.hasScopes() ? tokens.scopes() : [],
  };
}

export interface OAuthHandshake {
  state: string;
  codeVerifier: string;
  next: string;
  /** Which OAuth client started the flow; the callback must redeem the code with the same one. */
  client: GoogleClientKind;
}

/**
 * Start the redirect dance: mint `state` + PKCE verifier, persist them (with the post-login
 * destination and the client used) in the handshake cookies, return Google's authorization URL.
 * `scope: "operator"` uses the Gmail client and asks for Gmail; anything else is plain OIDC sign-in.
 */
export async function beginGoogleLogin(meta: { next: string; scope: "base" | "operator" }): Promise<URL> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const client: GoogleClientKind = meta.scope === "operator" ? "gmail" : "signin";
  const url = googleAuthUrl(state, codeVerifier, client === "gmail" ? GOOGLE_OPERATOR_SCOPES : GOOGLE_BASE_SCOPES, client);
  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: OAUTH_COOKIE_MAX_AGE };
  jar.set(OAUTH_STATE_COOKIE, JSON.stringify({ state, next: meta.next, client }), opts);
  jar.set(OAUTH_VERIFIER_COOKIE, codeVerifier, opts);
  return url;
}

/** Read and clear the handshake cookies. Null when either is missing or malformed. */
export async function takeOAuthCookies(): Promise<OAuthHandshake | null> {
  const jar = await cookies();
  const rawState = jar.get(OAUTH_STATE_COOKIE)?.value;
  const codeVerifier = jar.get(OAUTH_VERIFIER_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  jar.delete(OAUTH_VERIFIER_COOKIE);
  if (!rawState || !codeVerifier) return null;
  try {
    const parsed = JSON.parse(rawState) as { state?: unknown; next?: unknown; client?: unknown };
    if (typeof parsed.state !== "string") return null;
    return { state: parsed.state, codeVerifier, next: typeof parsed.next === "string" ? parsed.next : "/", client: parsed.client === "gmail" ? "gmail" : "signin" };
  } catch {
    return null;
  }
}
