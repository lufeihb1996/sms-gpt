import { NextRequest, NextResponse } from "next/server";
import { getSession, publicAccess } from "@/lib/auth";
import { checkAndReleaseOrder } from "@/lib/expired-orders";
import { apiError, providerError } from "@/lib/http";
import { findOrder, publicOrder } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("登录状态已失效，请重新输入卡密", 401, "unauthorized");

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return apiError("缺少订单号");

  try {
    const order = await findOrder(session.id, id);
    if (!order) return apiError("没有找到这个订单", 404, "order_not_found");

    if (["received", "completed"].includes(order.status) && order.sms_code) {
      return NextResponse.json({ ok: true, order: publicOrder(order), access: publicAccess(session) });
    }

    if (order.status !== "waiting") {
      return NextResponse.json({ ok: true, order: publicOrder(order), access: publicAccess(session) });
    }

    await checkAndReleaseOrder(order);
    const updated = await findOrder(session.id, id);
    const freshSession = await getSession();
    return NextResponse.json({
      ok: true,
      order: updated ? publicOrder(updated) : publicOrder(order),
      access: freshSession ? publicAccess(freshSession) : publicAccess(session),
    });
  } catch (error) {
    return providerError(error);
  }
}
