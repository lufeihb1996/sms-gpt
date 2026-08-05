import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  if (session) {
    await getSupabaseAdmin()
      .from("user_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", session.id);
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
