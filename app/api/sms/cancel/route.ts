import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { apiError, asString, providerError } from "@/lib/http";
import { findOrder } from "@/lib/orders";
import { cancelOrder } from "@/lib/smsman";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("登录状态已失效", 401, "unauthorized");

  let body: { id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("缺少订单号");
  }
  const id = asString(body.id, 80);
  const order = id ? await findOrder(session.id, id) : null;
  if (!order || order.status !== "waiting") return apiError("当前订单不能取消", 409);

  try {
    await cancelOrder(order.provider_request_id);
    await getSupabaseAdmin()
      .from("sms_orders")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("session_id", session.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return providerError(error);
  }
}
