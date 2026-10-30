"use client";

import { createContext } from "react";

/** Whether Google sign-in is configured (NEXT_PUBLIC_GOOGLE_AUTH_CONFIGURED, derived from GOOGLE_CLIENT_ID at build). The app renders either way. */
export const AuthConfigContext = createContext<{ configured: boolean }>({ configured: false });
