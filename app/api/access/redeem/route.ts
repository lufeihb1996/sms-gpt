import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { allowRequest, apiError, asString } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await allowRequest(req, "redeem", 8, 30))) {
    return apiError("尝试次数过多，请 30 秒后再试", 429, "rate_limited");
  }

  let body: { code?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("请输入有效卡密");
  }

  const code = asString(body.code, 80).toUpperCase();
  if (code.length < 8) return apiError("请输入有效卡密");

  const sessionToken = createSessionToken();
  const { data, error } = await getSupabaseAdmin().rpc("redeem_access_code", {
    p_code: code,
    p_session_hash: sessionToken.hash,
    p_session_expires_at: sessionToken.expiresAt.toISOString(),
  });

  const redeemed = Array.isArray(data) ? data[0] : data;
  if (error || !redeemed) {
    return apiError("卡密无效、已过期或次数已经用完", 401, "invalid_access_code");
  }

  await setSessionCookie(sessionToken.token, new Date(redeemed.expires_at));
  return NextResponse.json({ ok: true });
}
