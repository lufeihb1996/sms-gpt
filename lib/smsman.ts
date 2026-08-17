/**
 * sms-man.com 官方 v2 接口客户端(只服务美区 OpenAI / ChatGPT)
 *
 * 对应官方 API 文档(全部请求带 token):
 *   https://api.sms-man.com/control/get-balance?token=...
 *   https://api.sms-man.com/control/get-number?token=...&country_id=...&application_id=...
 *   https://api.sms-man.com/control/get-sms?token=...&request_id=...
 *   https://api.sms-man.com/control/set-status?token=...&request_id=...&status=...
 *   https://api.sms-man.com/control/countries?token=...
 *   https://api.sms-man.com/control/applications?token=...
 *
 * 说明:
 * - 新接口的国家 / 服务都是「整数 id」(country_id / application_id),不再用
 *   "US" / "ch" 这种字符串。本客户端固定使用 SMS-Man 官方的美国 country_id=5，
 *   服务 application_id 由业务服务配置指定。
 */

// This product is intentionally tied to SMS-Man's official API. Do not allow a
// deployment variable to silently redirect credentials or number purchases.
const BASE_URL = "https://api.sms-man.com";
const TOKEN = process.env.SMSMAN_API_TOKEN || "";

// 可直接用整数 id 覆盖;留空则自动查询解析
// SMS-Man documents country_id=5 as USA. The UI promises US numbers, so this
// value must not be overridden independently in Vercel.
const USA_COUNTRY_ID = "5";
const APPLICATION_ID = process.env.SMSMAN_APPLICATION_ID || "";

const COUNTRY = process.env.SMSMAN_COUNTRY || "US"; // 国家名/别名,用于自动解析
const SERVICE = process.env.SMSMAN_SERVICE || "OpenAI/ChatGPT"; // OpenAI/ChatGPT 服务代码
const MAX_PRICE = process.env.SMSMAN_MAX_PRICE || "";
const CURRENCY = process.env.SMSMAN_CURRENCY || "USD";

export interface NumberOrder {
  id: string;
  number: string;
  cost: string;
  status: string;
}

export interface SmsResult {
  code?: string;
  status: string;
}

// SMS-Man returns one of these after an activation has already expired or was
// released. For cleanup/swap purposes that is a successful terminal outcome,
// not a provider failure.
const RELEASED_ORDER_CODES = ["no_activation", "request_not_found", "wrong_request"];
const NUMBER_RETRY_DELAYS_MS = [0, 1200, 2500, 4000];

/** 统一错误,携带 sms-man 返回的 error_code */
export class SmsmanError extends Error {
  code: string;
  constructor(message: string, code = "api_error") {
    super(message);
    this.name = "SmsmanError";
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** 发送请求到 /control/<path>。所有请求统一 GET + query(官方示例如此)。 */
async function api(
  path: string,
  params: Record<string, string>,
  allowedErrorCodes: string[] = []
): Promise<Json> {
  if (!TOKEN) {
    throw new SmsmanError("SMS 通道尚未配置", "missing_token");
  }
  const payload: Record<string, string> = { token: TOKEN, ...params };
  const query = new URLSearchParams(payload).toString();
  const cleanPath = path.replace(/^\/+/, ""); // 去掉前导 /,避免 control//get-number
  const url = `${BASE_URL}/control/${cleanPath}?${query}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new SmsmanError(`请求 sms-man 网络错误: ${(e as Error).message}`);
  }

  let json: Json;
  try {
    json = await res.json();
  } catch {
    throw new SmsmanError(`sms-man 返回了非 JSON 响应(HTTP ${res.status})`);
  }

  const errorCode = json?.error_code ? String(json.error_code) : "";
  if (errorCode && allowedErrorCodes.includes(errorCode)) {
    return json;
  }

  if (json && (json.error_msg || json.error_code)) {
    const raw =
      typeof json.error_msg === "string"
        ? json.error_msg
        : JSON.stringify(json.error_msg ?? json.error_code ?? "api_error");
    throw new SmsmanError(raw, String(json.error_code || "api_error"));
  }
  return json;
}

/* ---------- 国家 / 服务 id 自动解析(模块级缓存) ---------- */

let cachedApplicationId: string | null | undefined;

/** 兼容接口返回两种格式:数组或按 id 为 key 的对象字典 */
function toArray<T>(raw: Json): T[] {
  if (Array.isArray(raw)) return raw as T[];
  return Object.values((raw || {}) as Record<string, T>);
}

/** 解析美国 country_id；本产品固定提供美国号码。 */
async function resolveCountryId(): Promise<string> {
  return USA_COUNTRY_ID;
}

/** 解析 OpenAI/ChatGPT application_id;可直接环境变量覆盖 */
async function resolveApplicationId(serviceArg?: string): Promise<string> {
  if (APPLICATION_ID) return APPLICATION_ID;
  if (cachedApplicationId !== undefined) return cachedApplicationId ?? "";
  cachedApplicationId = null;
  try {
    const list = toArray<{ id?: number | string; code?: string; title?: string }>(
      await api("/applications", {})
    );
    const target = (serviceArg || SERVICE).toLowerCase();
    const hit =
      list.find((a) => String(a.code || "").toLowerCase() === target) ||
      list.find((a) => String(a.title || "").toLowerCase() === target) ||
      list.find((a) => /openai|chat ?gpt/i.test(String(a.title || "")));
    if (hit && hit.id != null) cachedApplicationId = String(hit.id);
  } catch {
    /* 解析失败时交给下单处提示 */
  }
  return cachedApplicationId ?? "";
}

/* ------------------ 对外业务函数 ------------------ */

/** 下单获取一个新号码(固定美区、ChatGPT/OpenAI 服务) */
export async function getNumber(
  overrides: { country?: string; service?: string; applicationId?: string; maxPrice?: string } = {}
): Promise<NumberOrder> {
  const countryId = await resolveCountryId();
  if (!countryId) {
    throw new SmsmanError("SMS-Man 美国 country_id 配置缺失", "missing_country");
  }
  const applicationId = overrides.applicationId || await resolveApplicationId(overrides.service);
  if (!applicationId) {
    throw new SmsmanError(
      "未能自动解析 OpenAI/ChatGPT 的 application_id,请在 .env.local 中设置 SMSMAN_APPLICATION_ID(可通过 /control/applications 查询)"
    );
  }

  const params: Record<string, string> = {
    country_id: countryId,
    application_id: applicationId,
  };
  const maxPrice = overrides.maxPrice || MAX_PRICE;
  if (maxPrice) {
    params.maxPrice = maxPrice;
    params.currency = CURRENCY;
  }

  let json: Json;
  for (let attempt = 0; ; attempt += 1) {
    try {
      json = await api("/get-number", params);
      break;
    } catch (error) {
      const retryDelay = NUMBER_RETRY_DELAYS_MS[attempt + 1];
      if (!(error instanceof SmsmanError) || error.code !== "no_numbers" || retryDelay === undefined) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  const id = json.request_id;
  const number = json.number;
  if (id == null || !number) {
    throw new SmsmanError("sms-man 未返回号码,请检查余额 / 国家或服务是否可用");
  }

  const returnedCountryId = json.country_id == null ? "" : String(json.country_id);
  const normalizedNumber = String(number).replace(/\D/g, "");
  const looksLikeUsNumber = /^(?:1)?[2-9]\d{9}$/.test(normalizedNumber);
  if ((returnedCountryId && returnedCountryId !== USA_COUNTRY_ID) || !looksLikeUsNumber) {
    await api(
      "/set-status",
      { request_id: String(id), status: "close" },
      RELEASED_ORDER_CODES
    ).catch(() => undefined);
    throw new SmsmanError("SMS-Man returned a non-US number", "wrong_country");
  }
  return {
    id: String(id),
    number: String(number),
    cost: json.cost != null ? String(json.cost) : "0",
    status: "ready",
  };
}

/** 读取验证码;若短信未到则返回不带 code 的 waiting_code 状态 */
export async function getSms(id: string): Promise<SmsResult> {
  const json = await api("/get-sms", { request_id: id }, ["wait_sms", ...RELEASED_ORDER_CODES]);
  if (json.error_code) {
    return { status: json.error_code === "wait_sms" ? "waiting_code" : String(json.error_code) };
  }
  const code = json.sms_code;
  return {
    code: code != null ? String(code) : undefined,
    status: "sms_received",
  };
}

/** 查询验证码/是否已到(新接口没有独立查单接口,复用 get-sms) */
export async function getStatus(id: string): Promise<SmsResult> {
  const json = await api("/get-sms", { request_id: id }, ["wait_sms", ...RELEASED_ORDER_CODES]);
  if (json.error_code) {
    return { status: json.error_code === "wait_sms" ? "waiting_code" : String(json.error_code) };
  }
  const code = json.sms_code;
  return {
    code: code != null ? String(code) : undefined,
    status: "sms_received",
  };
}

/** 取消 / 释放号码(未收到短信可退回):set-status = close */
export async function cancelOrder(id: string): Promise<{ status: string }> {
  const json = await api("/set-status", { request_id: id, status: "close" }, RELEASED_ORDER_CODES);
  return { status: json.error_code ? String(json.error_code) : "cancel" };
}

/** 拒绝当前无效号码，用于换号；与普通关闭订单的 close 分开。 */
export async function rejectOrder(id: string): Promise<{ status: string }> {
  const json = await api("/set-status", { request_id: id, status: "reject" }, RELEASED_ORDER_CODES);
  return { status: json.error_code ? String(json.error_code) : "reject" };
}

/** 标记号码已成功使用,供应商可据此结束订单。 */
export async function markOrderUsed(id: string): Promise<{ status: string }> {
  await api("/set-status", { request_id: id, status: "used" });
  return { status: "used" };
}

/** 查询余额 */
export async function getBalance(): Promise<{ balance: number | null }> {
  const json = await api("/get-balance", {});
  return { balance: json.balance != null ? Number(json.balance) : null };
}

/** 查询当前配置(便于前端展示 / 调试) */
export function getConfig() {
  return {
    country: COUNTRY,
    service: SERVICE,
    maxPrice: MAX_PRICE || null,
    currency: CURRENCY,
    baseUrl: `${BASE_URL}/control`,
  };
}
