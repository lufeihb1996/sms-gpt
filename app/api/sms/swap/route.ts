import { NextRequest, NextResponse } from "next/server";
import { getSession, publicAccess } from "@/lib/auth";
import { allowRequest, apiError, asString, providerError } from "@/lib/http";
import { findOrder, orderTimes, publicOrder, type StoredOrder } from "@/lib/orders";
import { cancelOrder, getNumber, getSms, markOrderUsed, rejectOrder } from "@/lib/smsman";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

async function buyReplacement(sessionId: string, oldOrder: StoredOrder) {
  const purchased = await getNumber({
    service: oldOrder.service,
    applicationId: oldOrder.application_id,
  });
  const times = orderTimes(oldOrder.service);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sms_orders")
    .insert({
      session_id: sessionId,
      provider_request_id: purchased.id,
      service: oldOrder.service,
      application_id: oldOrder.application_id,
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
    throw error || new Error("补号保存失败");
  }

  await supabase
    .from("sms_orders")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", oldOrder.id)
    .in("status", ["swapping", "replacement_pending"]);

  return data as StoredOrder;
}

export async function POST(req: NextRequest) {
  if (!(await allowRequest(req, "swap-number", 6, 60))) {
    return apiError("换号操作太频繁，请稍后再试", 429, "rate_limited");
  }

  const session = await getSession();
  if (!session) return apiError("登录状态已失效，请重新输入卡密", 401, "unauthorized");

  let body: { id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("缺少订单号");
  }
  const id = asString(body.id, 80);
  if (!id) return apiError("缺少订单号");

  try {
    const order = await findOrder(session.id, id);
    if (!order) return apiError("没有找到这个订单", 404, "order_not_found");

    if (order.status === "replacement_pending") {
      const replacement = await buyReplacement(session.id, order);
      return NextResponse.json({
        ok: true,
        order: publicOrder(replacement),
        access: publicAccess(session),
      });
    }

    if (order.status !== "waiting") {
      return apiError("当前订单不能换号", 409, "invalid_order_state");
    }

    if (new Date(order.can_swap_at) > new Date()) {
      return apiError("倒计时结束后才能换号", 409, "swap_too_early");
    }

    const lastCheck = await getSms(order.provider_request_id);
    if (lastCheck.code) {
      const { data: completed } = await getSupabaseAdmin().rpc("complete_sms_order", {
        p_order_id: order.id,
        p_sms_code: lastCheck.code,
      });
      if (completed === true) await markOrderUsed(order.provider_request_id).catch(() => undefined);
      const updated = await findOrder(session.id, order.id);
      return NextResponse.json({
        ok: true,
        order: updated ? publicOrder(updated) : { ...publicOrder(order), status: "received", code: lastCheck.code },
        access: publicAccess(session),
        receivedBeforeSwap: true,
      });
    }

    const { data: locked, error: lockError } = await getSupabaseAdmin().rpc("begin_sms_swap", {
      p_order_id: order.id,
    });
    if (lockError || locked !== true) {
      return apiError("换号次数已用完，或订单状态刚刚发生变化", 409, "swap_unavailable");
    }

    try {
      await rejectOrder(order.provider_request_id);
    } catch (error) {
      await getSupabaseAdmin().rpc("rollback_sms_swap", {
        p_order_id: order.id,
        p_status: "waiting",
        p_refund_swap: true,
      });
      throw error;
    }

    try {
      const replacement = await buyReplacement(session.id, order);
      const freshSession = await getSession();
      return NextResponse.json({
        ok: true,
        order: publicOrder(replacement),
        access: freshSession ? publicAccess(freshSession) : publicAccess(session),
      });
    } catch (error) {
      await getSupabaseAdmin().rpc("rollback_sms_swap", {
        p_order_id: order.id,
        p_status: "replacement_pending",
        p_refund_swap: false,
      });
      throw error;
    }
  } catch (error) {
    return providerError(error);
  }
}
