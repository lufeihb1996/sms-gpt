import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { allowRequest, apiError, asString } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccessCodeRow {
  id: string;
  code_plaintext: string | null;
  code_hint: string;
  label: string | null;
  max_successes: number;
  successes_used: number;
  max_swaps: number;
  swaps_used: number;
  expires_at: string;
  disabled: boolean;
  created_at: string;
}

function publicCode(row: AccessCodeRow) {
  return {
    id: row.id,
    code: row.code_plaintext,
    hint: row.code_hint,
    label: row.label,
    maxSuccesses: row.max_successes,
    successesUsed: row.successes_used,
    maxSwaps: row.max_swaps,
    swapsUsed: row.swaps_used,
    expiresAt: row.expires_at,
    disabled: row.disabled,
    createdAt: row.created_at,
  };
}

async function requireAdmin() {
  const session = await getSession();
  return session?.access.role === "admin" ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return apiError("仅管理员可以查看卡密", 403, "admin_required");
  }

  const { data, error } = await getSupabaseAdmin()
    .from("access_codes")
    .select(
      "id, code_plaintext, code_hint, label, max_successes, successes_used, max_swaps, swaps_used, expires_at, disabled, created_at"
    )
    .eq("role", "customer")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return apiError("读取卡密失败，请稍后重试", 500, "list_failed");
  return NextResponse.json({ ok: true, codes: (data as AccessCodeRow[]).map(publicCode) });
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) {
    return apiError("仅管理员可以生成卡密", 403, "admin_required");
  }
  if (!(await allowRequest(req, "admin-create-code", 20, 60))) {
    return apiError("生成操作太频繁，请稍后再试", 429, "rate_limited");
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return apiError("卡密参数格式不正确");
  }

  const label = asString(body.label, 80) || "闲鱼买家";
  const validDays = Math.min(365, Math.max(1, Number(body.validDays) || 7));
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const compact = randomBytes(8).toString("hex").toUpperCase();
    const code = `XY-${compact.match(/.{1,4}/g)?.join("-")}`;
    const { data, error } = await getSupabaseAdmin().rpc("create_access_code", {
      p_code: code,
      p_label: label,
      p_max_successes: 1,
      p_max_swaps: 1,
      p_expires_at: expiresAt.toISOString(),
    });

    const created = Array.isArray(data) ? data[0] : data;
    if (created) {
      return NextResponse.json({
        ok: true,
        generatedCode: code,
        generatedId: created.id,
      });
    }
    if (error?.code !== "23505") {
      return apiError("生成卡密失败，请稍后重试", 500, "create_failed");
    }
  }

  return apiError("生成卡密失败，请重新操作", 500, "create_failed");
}
