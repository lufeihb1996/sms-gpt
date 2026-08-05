import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";

export const SESSION_COOKIE = "verify_session";
const SESSION_DAYS = 7;

export interface AccessSession {
  id: string;
  accessCodeId: string;
  expiresAt: string;
  access: {
    role: "admin" | "customer";
    label: string | null;
    maxSuccesses: number;
    successesUsed: number;
    maxSwaps: number;
    swapsUsed: number;
    expiresAt: string;
  };
}

export function publicAccess(session: AccessSession) {
  return {
    isAdmin: session.access.role === "admin",
    label: session.access.label,
    remainingSuccesses: Math.max(0, session.access.maxSuccesses - session.access.successesUsed),
    remainingSwaps: Math.max(0, session.access.maxSwaps - session.access.swapsUsed),
    maxSuccesses: session.access.maxSuccesses,
    maxSwaps: session.access.maxSwaps,
    expiresAt: session.access.expiresAt,
  };
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSessionToken(): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashValue(token),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
  };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

export async function getSession(): Promise<AccessSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  const { data: session, error: sessionError } = await supabase
    .from("user_sessions")
    .select("id, access_code_id, expires_at, revoked_at")
    .eq("token_hash", hashValue(token))
    .maybeSingle();

  if (sessionError || !session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
    return null;
  }

  const { data: access, error: accessError } = await supabase
    .from("access_codes")
    .select("role, label, max_successes, successes_used, max_swaps, swaps_used, expires_at, disabled")
    .eq("id", session.access_code_id)
    .maybeSingle();

  if (accessError || !access || access.disabled || new Date(access.expires_at) <= new Date()) {
    return null;
  }

  return {
    id: session.id,
    accessCodeId: session.access_code_id,
    expiresAt: session.expires_at,
    access: {
      role: access.role === "admin" ? "admin" : "customer",
      label: access.label,
      maxSuccesses: access.max_successes,
      successesUsed: access.successes_used,
      maxSwaps: access.max_swaps,
      swapsUsed: access.swaps_used,
      expiresAt: access.expires_at,
    },
  };
}
