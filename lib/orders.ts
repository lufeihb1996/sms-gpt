import { getSupabaseAdmin } from "@/lib/supabase";

export const ACTIVE_ORDER_STATUSES = ["waiting", "received", "swapping", "replacement_pending"];

export interface StoredOrder {
  id: string;
  session_id: string;
  provider_request_id: string;
  service: string;
  application_id: string;
  phone: string;
  cost: string;
  status: string;
  sms_code: string | null;
  can_swap_at: string;
  expires_at: string;
  created_at: string;
}

export interface PublicOrder {
  id: string;
  service: string;
  number: string;
  status: string;
  code?: string;
  canSwapAt: string;
  expiresAt: string;
  createdAt: string;
}

export function publicOrder(order: StoredOrder): PublicOrder {
  return {
    id: order.id,
    service: order.service || "chatgpt",
    number: order.phone,
    status: order.status,
    code: order.sms_code || undefined,
    canSwapAt: order.can_swap_at,
    expiresAt: order.expires_at,
    createdAt: order.created_at,
  };
}

export async function latestOrder(sessionId: string): Promise<StoredOrder | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("sms_orders")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as StoredOrder | null;
}

export async function findOrder(sessionId: string, orderId: string): Promise<StoredOrder | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("sms_orders")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) throw error;
  return data as StoredOrder | null;
}

export function orderTimes() {
  // SMS-Man keeps disposable activations alive for roughly 10 minutes and can
  // reject an earlier release with `early_cancel_denied`. Keep our countdown
  // aligned with the provider so the UI does not promise a swap too early.
  const swapSeconds = Math.max(600, Number(process.env.SMS_SWAP_WAIT_SECONDS || 600));
  const ttlSeconds = Math.max(swapSeconds, Number(process.env.SMS_ORDER_TTL_SECONDS || 600));
  const now = Date.now();
  return {
    canSwapAt: new Date(now + swapSeconds * 1000).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}
