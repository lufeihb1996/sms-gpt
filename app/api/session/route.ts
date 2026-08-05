import { NextResponse } from "next/server";
import { clearSessionCookie, getSession, publicAccess } from "@/lib/auth";
import { latestOrder, publicOrder } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      await clearSessionCookie();
      return NextResponse.json({ ok: true, authenticated: false });
    }

    const order = await latestOrder(session.id);
    return NextResponse.json({
      ok: true,
      authenticated: true,
      access: publicAccess(session),
      order: order ? publicOrder(order) : null,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "服务配置尚未完成，请联系卖家" },
      { status: 503 }
    );
  }
}
