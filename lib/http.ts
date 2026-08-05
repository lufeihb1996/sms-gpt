import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { SmsmanError } from "@/lib/smsman";

export function clientKey(req: NextRequest, scope: string): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  return createHash("sha256").update(`${scope}:${ip}`).digest("hex");
}

export async function allowRequest(
  req: NextRequest,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("take_rate_limit", {
      p_key: clientKey(req, scope),
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export function apiError(message: string, status = 400, code = "request_error") {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

export function providerError(error: unknown) {
  const code = error instanceof SmsmanError ? error.code : "provider_error";
  console.error("SMS-Man request failed", {
    code,
    message: error instanceof Error ? error.message : "Unknown provider error",
  });
  const friendly: Record<string, string> = {
    no_numbers: "当前美国号码库存紧张，请稍后重试",
    no_balance: "服务暂时不可用，请联系卖家处理",
    low_balance: "服务暂时不可用，请联系卖家处理",
    wrong_max_price: "当前通道价格发生变化，请联系卖家处理",
    wait_sms: "验证码仍在路上，请继续等待",
    timeout: "号码通道响应超时，请稍后重试",
    early_cancel_denied: "号码暂时不能更换，请等待一分钟后再试",
    early_reject_denied: "号码暂时不能更换，请等待一分钟后再试",
    no_activation: "原号码订单已失效，请刷新页面或联系卖家",
    request_not_found: "原号码订单已失效，请刷新页面或联系卖家",
  };

  return apiError(friendly[code] || "号码通道暂时繁忙，请稍后重试", 502, code);
}

export function asString(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
