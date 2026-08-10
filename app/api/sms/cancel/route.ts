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
  if (session.access.role !== "admin") return apiError("只有管理员可以切换进行中的服务", 403, "forbidden");

  let body: { id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("缺少订单号");
  }
  const id = asString(body.id, 80);
  const order = id ? await findOrder(session.id, id) : null;
  if (!order || !["waiting", "replacement_pending"].includes(order.status)) {
    return apiError("当前订单不能取消", 409);
  }

  try {
    if (order.status === "waiting") {
      await cancelOrder(order.provider_request_id);
    }
    await getSupabaseAdmin()
      .from("sms_orders")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("session_id", session.id)
      .in("status", ["waiting", "replacement_pending"]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return providerError(error);
  }
}
