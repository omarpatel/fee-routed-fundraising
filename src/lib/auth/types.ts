import type { User } from "@/lib/db/schema";

/** `GET /api/auth/session` payload: the `users` row plus whether a Gmail refresh token is on file. */
export type SessionUser = User & { gmailConnected: boolean };
