import { NextRequest, NextResponse } from "next/server";
import { getSession, publicAccess } from "@/lib/auth";
import { allowRequest, apiError, asString, providerError } from "@/lib/http";
import { latestOrder, orderTimes, publicOrder, type StoredOrder } from "@/lib/orders";
import { defaultSmsService, findSmsService } from "@/lib/services";
import { cancelOrder, getNumber } from "@/lib/smsman";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await allowRequest(req, "new-number", 10, 60))) {
    return apiError("操作太频繁，请稍后再试", 429, "rate_limited");
  }

  const session = await getSession();
  if (!session) return apiError("请先输入闲鱼订单卡密", 401, "unauthorized");

  let body: { service?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 兼容未传请求体的旧客户端，默认使用 ChatGPT。
  }
  const requestedService = body.service === undefined
    ? defaultSmsService()
    : findSmsService(asString(body.service, 32));
  if (!requestedService) return apiError("暂不支持这个接码服务", 400, "unsupported_service");

  try {
    const previous = await latestOrder(session.id);
    if (previous && ["waiting", "received", "swapping", "replacement_pending"].includes(previous.status)) {
      return NextResponse.json({
        ok: true,
        order: publicOrder(previous),
        access: publicAccess(session),
        restored: true,
      });
    }

    const adminCanRestart = session.access.role === "admin" &&
      previous && ["cancelled", "expired", "closed", "failed"].includes(previous.status);
    if (previous && !["received", "completed"].includes(previous.status) && !adminCanRestart) {
      return apiError("当前服务需要从原订单继续处理，请联系卖家", 409, "order_interrupted");
    }

    if (session.access.successesUsed >= session.access.maxSuccesses) {
      return apiError("此卡密的服务次数已经用完", 409, "quota_exhausted");
    }

    if (previous?.status === "received") {
      await getSupabaseAdmin()
        .from("sms_orders")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", previous.id)
        .eq("session_id", session.id);
    }

    const purchased = await getNumber({
      service: requestedService.description,
      applicationId: requestedService.applicationId,
    });
    const times = orderTimes();
    const { data, error } = await getSupabaseAdmin()
      .from("sms_orders")
      .insert({
        session_id: session.id,
        provider_request_id: purchased.id,
        service: requestedService.id,
        application_id: requestedService.applicationId,
        phone: purchased.number,
        cost: purchased.cost || "0",
        status: "waiting",
        can_swap_at: times.canSwapAt,
        expires_at: times.expiresAt,
      })
      .select("*")
      .single();

    if (error || !data) {
      await cancelOrder(purchased.id).catch(() => undefined);
      throw error || new Error("订单保存失败");
    }

    return NextResponse.json({
      ok: true,
      order: publicOrder(data as StoredOrder),
      access: publicAccess(session),
    });
  } catch (error) {
    return providerError(error);
  }
}
