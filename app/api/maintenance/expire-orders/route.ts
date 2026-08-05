import { NextRequest, NextResponse } from "next/server";
import { checkAndReleaseOrder, type ExpirableOrder } from "@/lib/expired-orders";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CLEANUP_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sms_orders")
    .select("id, provider_request_id, expires_at")
    .eq("status", "waiting")
    .lte("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(20);

  if (error) {
    return NextResponse.json({ ok: false, error: "Failed to load expired orders" }, { status: 500 });
  }

  let received = 0;
  let released = 0;
  let failed = 0;

  let pending = 0;

  for (const order of (data || []) as ExpirableOrder[]) {
    try {
      const result = await checkAndReleaseOrder(order);
      if (result === "received") received += 1;
      if (result === "replacement_pending") pending += 1;
      if (result === "replacement_pending" || result === "expired") released += 1;
    } catch (orderError) {
      failed += 1;
      console.error("Expired SMS order cleanup failed", {
        orderId: order.id,
        message: orderError instanceof Error ? orderError.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({ ok: true, checked: data?.length || 0, received, released, pending, failed });
}
