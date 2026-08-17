"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SMS_SERVICE_OPTIONS, type SmsServiceKey } from "@/lib/services";

interface AccessInfo {
  isAdmin: boolean;
  label: string | null;
  remainingSuccesses: number;
  remainingSwaps: number;
  maxSuccesses: number;
  maxSwaps: number;
  expiresAt: string;
}

interface ManagedAccessCode {
  id: string;
  code: string | null;
  hint: string;
  label: string | null;
  maxSuccesses: number;
  successesUsed: number;
  maxSwaps: number;
  swapsUsed: number;
  expiresAt: string;
  disabled: boolean;
  createdAt: string;
}

interface OrderInfo {
  id: string;
  service: SmsServiceKey;
  number: string;
  status: string;
  code?: string;
  canSwapAt: string;
  expiresAt: string;
  createdAt: string;
}

interface ApiPayload {
  ok: boolean;
  authenticated?: boolean;
  error?: string;
  code?: string;
  order?: OrderInfo | null;
  access?: AccessInfo;
  codes?: ManagedAccessCode[];
  generatedCode?: string;
}

const POLL_INTERVAL = 8000;

async function requestJson(url: string, init?: RequestInit): Promise<ApiPayload> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => ({}))) as ApiPayload;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "请求失败，请稍后重试");
  }
  return payload;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatPhone(number: string) {
  const digits = number.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return number.startsWith("+") ? number : `+${number}`;
}

export default function Home() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [selectedService, setSelectedService] = useState<SmsServiceKey>("chatgpt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [managedCodes, setManagedCodes] = useState<ManagedAccessCode[]>([]);
  const [generatedCode, setGeneratedCode] = useState("");
  const [adminForm, setAdminForm] = useState({
    label: "",
    validDays: 7,
  });
  const [now, setNow] = useState(Date.now());
  const polling = useRef(false);

  const applyPayload = useCallback((payload: ApiPayload) => {
    if (typeof payload.authenticated === "boolean") setAuthenticated(payload.authenticated);
    if (payload.access) {
      setAccess(payload.access);
      if (!payload.access.isAdmin) setAdminOpen(false);
    }
    if (payload.order !== undefined) {
      setOrder(payload.order);
      if (payload.order?.service) setSelectedService(payload.order.service);
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const payload = await requestJson("/api/session");
      applyPayload(payload);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBooting(false);
    }
  }, [applyPayload]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const checkCode = useCallback(async () => {
    if (!order || order.status !== "waiting" || polling.current) return;
    polling.current = true;
    try {
      const payload = await requestJson(`/api/sms/code?id=${encodeURIComponent(order.id)}`);
      applyPayload(payload);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      polling.current = false;
    }
  }, [applyPayload, order]);

  useEffect(() => {
    if (!order || order.status !== "waiting") return;
    const timer = window.setInterval(checkCode, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [checkCode, order]);

  const secondsToSwap = order
    ? Math.max(0, Math.ceil((new Date(order.canSwapAt).getTime() - now) / 1000))
    : 0;
  const waitDuration = order
    ? Math.max(1, new Date(order.canSwapAt).getTime() - new Date(order.createdAt).getTime())
    : 1;
  const progress = order
    ? Math.min(100, Math.max(0, ((now - new Date(order.createdAt).getTime()) / waitDuration) * 100))
    : 0;
  const canSwap = Boolean(
    order &&
      (order.status === "replacement_pending" ||
        (order.status === "waiting" && secondsToSwap === 0 && (access?.remainingSwaps || 0) > 0))
  );

  const phase = useMemo(() => {
    if (!authenticated) return 0;
    if (!order) return 1;
    if (["received", "completed"].includes(order.status)) return 3;
    return 2;
  }, [authenticated, order]);

  async function redeem(event: FormEvent) {
    event.preventDefault();
    if (accessCode.trim().length < 8) {
      setError("请输入闲鱼卖家提供的完整卡密");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/access/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: accessCode }),
      });
      setAccessCode("");
      await loadSession();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function acquireNumber() {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson("/api/sms/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: selectedService }),
      });
      applyPayload(payload);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function swapNumber() {
    if (!order || !canSwap) return;
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson("/api/sms/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: order.id }),
      });
      applyPayload(payload);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function switchService() {
    if (!order || !access?.isAdmin) return;
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/sms/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: order.id }),
      });
      setOrder(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadAdminCodes() {
    const payload = await requestJson("/api/admin/access-codes");
    setManagedCodes(payload.codes || []);
  }

  async function toggleAdmin() {
    if (adminOpen) {
      setAdminOpen(false);
      setGeneratedCode("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await loadAdminCodes();
      setAdminOpen(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function generateAccessCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setGeneratedCode("");
    try {
      const payload = await requestJson("/api/admin/access-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adminForm),
      });
      setGeneratedCode(payload.generatedCode || "");
      await loadAdminCodes();
      setAdminForm((current) => ({ ...current, label: "" }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await requestJson("/api/access/logout", { method: "POST" });
      setAuthenticated(false);
      setAccess(null);
      setOrder(null);
      setAdminOpen(false);
      setManagedCodes([]);
      setGeneratedCode("");
      setError("");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("复制失败，请长按内容手动复制");
    }
  }

  return (
    <main className="page-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="topbar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>验证码助手</span>
        </div>
        <div className="secure-label"><span /> 安全连接</div>
      </nav>

      <section className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow"><span /> 美国号码 · 自动收码</div>
          <h1>验证码到了，<br /><em>第一时间告诉你。</em></h1>
          <p className="hero-lead">
            获取号码、等待短信、复制验证码，一页完成。无需重复刷新，系统会自动查询。
          </p>

          <div className="trust-row" aria-label="服务特点">
            <div><b>8 秒</b><span>自动查询</span></div>
            <div>
              <b>{(order?.service || selectedService) === "soulapp" ? "10 分钟" : "3 分钟"}</b>
              <span>未收码可换号</span>
            </div>
            <div><b>全程</b><span>订单可追踪</span></div>
          </div>

          <div className="how-it-works">
            <div><span>01</span><p><b>输入服务卡密</b><small>使用闲鱼卖家发给你的卡密</small></p></div>
            <div><span>02</span><p><b>复制美国号码</b><small>前往目标平台提交验证码请求</small></p></div>
            <div><span>03</span><p><b>等待自动收码</b><small>验证码出现后点击即可复制</small></p></div>
          </div>
        </div>

        <div className="workspace-wrap">
          <section className="workspace" aria-busy={busy || booting}>
            <header className="workspace-head">
              <div>
                <span className="workspace-kicker">验证工作台</span>
                <h2>{adminOpen ? "卡密管理" : authenticated ? "当前服务" : "开始使用"}</h2>
              </div>
              {authenticated && (
                <div className="workspace-actions">
                  {access?.isAdmin && (
                    <button className="admin-menu-button" onClick={toggleAdmin} disabled={busy}>
                      {adminOpen ? "返回接码" : "卡密管理"}
                    </button>
                  )}
                  <button className="text-button" onClick={logout} disabled={busy}>更换卡密</button>
                </div>
              )}
            </header>

            {!adminOpen && (
              <div className="stepper" aria-label="服务进度">
                {["验证卡密", "获取号码", "接收短信"].map((label, index) => (
                  <div className={phase > index ? "step active" : phase === index ? "step current" : "step"} key={label}>
                    <span>{phase > index ? "✓" : index + 1}</span>
                    <small>{label}</small>
                  </div>
                ))}
              </div>
            )}

            {error && <div className="notice error" role="alert"><span>!</span><p>{error}</p></div>}

            {booting ? (
              <div className="loading-state"><span /><p>正在恢复你的服务进度…</p></div>
            ) : !authenticated ? (
              <form className="access-form" onSubmit={redeem}>
                <label htmlFor="access-code">闲鱼订单卡密</label>
                <div className="input-wrap">
                  <span aria-hidden="true">◆</span>
                  <input
                    id="access-code"
                    name="manual-access-code"
                    type="text"
                    value={accessCode}
                    onChange={(event) => {
                      const normalized = event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9-]/g, "")
                        .slice(0, 64);
                      setAccessCode(normalized);
                    }}
                    placeholder="例如：XY-2026-ABCD"
                    inputMode="text"
                    enterKeyHint="go"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={64}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    disabled={busy}
                  />
                </div>
                <button className="primary-button" disabled={busy || accessCode.trim().length < 8}>
                  {busy ? "正在验证…" : "验证卡密并进入"}
                </button>
                <p className="form-hint">卡密仅用于验证服务资格，不需要注册账号。</p>
              </form>
            ) : adminOpen && access?.isAdmin ? (
              <div className="admin-panel">
                <form className="admin-form" onSubmit={generateAccessCode}>
                  <div className="admin-intro">
                    <div>
                      <span>卖家工具</span>
                      <h3>生成买家卡密</h3>
                    </div>
                    <small>完整卡密仅管理员可查看</small>
                  </div>

                  <label>
                    闲鱼订单备注
                    <input
                      value={adminForm.label}
                      onChange={(event) => setAdminForm((current) => ({ ...current, label: event.target.value }))}
                      placeholder="例如：买家昵称 / 订单号"
                      maxLength={80}
                      disabled={busy}
                    />
                  </label>

                  <div className="admin-fields">
                    <label>
                      有效天数
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={adminForm.validDays}
                        onChange={(event) => setAdminForm((current) => ({ ...current, validDays: Number(event.target.value) }))}
                        disabled={busy}
                      />
                    </label>
                  </div>

                  <button className="primary-button" disabled={busy}>
                    {busy ? "正在生成…" : "生成新卡密"}
                  </button>
                </form>

                {generatedCode && (
                  <div className="generated-code" role="status">
                    <span>新卡密已生成</span>
                    <strong>{generatedCode}</strong>
                    <button onClick={() => copy(generatedCode, "generated")}>{copied === "generated" ? "已复制" : "复制发给买家"}</button>
                  </div>
                )}

                <div className="code-list">
                  <div className="code-list-head">
                    <b>最近生成</b>
                    <span>{managedCodes.length} 张卡密</span>
                  </div>
                  {managedCodes.length === 0 ? (
                    <p className="admin-empty">还没有买家卡密，先生成一张。</p>
                  ) : (
                    managedCodes.map((item) => (
                      <article className="code-card" key={item.id}>
                        <div>
                          <span>{item.label || "未填写备注"}</span>
                          <strong>{item.code || `•••• •••• ${item.hint}`}</strong>
                          <small>
                            成功接码 {item.successesUsed}/1 · 换号 {item.swapsUsed}/{item.maxSwaps} · {new Date(item.expiresAt).toLocaleDateString("zh-CN")} 到期
                          </small>
                        </div>
                        <button
                          onClick={() => item.code && copy(item.code, item.id)}
                          disabled={!item.code}
                        >
                          {copied === item.id ? "已复制" : item.code ? "复制" : "仅尾号"}
                        </button>
                      </article>
                    ))
                  )}
                </div>
              </div>
            ) : !order ? (
              <div className="empty-state">
                <div className="service-picker" role="radiogroup" aria-label="选择接码服务">
                  <span>选择接码服务</span>
                  <div>
                    {SMS_SERVICE_OPTIONS.map((service) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedService === service.id}
                        className={selectedService === service.id ? "service-option active" : "service-option"}
                        onClick={() => setSelectedService(service.id)}
                        disabled={busy}
                        key={service.id}
                      >
                        <b>{service.label}</b>
                        <small>{service.description}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="channel-card">
                  <div className="flag-badge">US</div>
                  <div>
                    <b>美国验证号码</b>
                    <span>用于 {SMS_SERVICE_OPTIONS.find((service) => service.id === selectedService)?.label}</span>
                  </div>
                  <span className="stock"><i /> 通道正常</span>
                </div>
                <button className="primary-button" onClick={acquireNumber} disabled={busy || !access?.remainingSuccesses}>
                  {busy ? "正在分配号码…" : "获取美国号码"}
                </button>
                <p className="form-hint">获取后请尽快在目标平台发送验证码。</p>
              </div>
            ) : (
              <div className="order-state">
                <div className="status-line">
                  <span className={`status-pill status-${order.status}`}><i />{
                    order.status === "received" || order.status === "completed"
                      ? "验证码已收到"
                      : order.status === "replacement_pending"
                        ? "等待补发新号码"
                        : order.status === "expired"
                          ? "号码已释放"
                        : order.status === "waiting"
                          ? "正在等待短信"
                          : "订单处理中"
                  }</span>
                  <small>订单 {order.id.slice(0, 8).toUpperCase()}</small>
                </div>

                {!['replacement_pending', 'expired', 'closed', 'cancelled', 'failed'].includes(order.status) && (
                <div className="number-panel">
                  <span>
                    {SMS_SERVICE_OPTIONS.find((service) => service.id === order.service)?.label || "当前服务"} · 你的美国号码
                  </span>
                  <div>
                    <strong>{formatPhone(order.number)}</strong>
                    <button onClick={() => copy(order.number.startsWith("+") ? order.number : `+${order.number}`, "phone")}>
                      {copied === "phone" ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
                )}

                {order.code ? (
                  <div className="code-result">
                    <span className="success-icon">✓</span>
                    <p>验证码已收到</p>
                    <button onClick={() => copy(order.code || "", "code")}>
                      <strong>{order.code}</strong>
                      <small>{copied === "code" ? "已复制到剪贴板" : "点击复制验证码"}</small>
                    </button>
                  </div>
                ) : order.status === "replacement_pending" ? (
                  <div className="replacement-state">
                    <p>第 1 个号码未收到短信，现已自动释放。点击后再获取最后 1 个号码。</p>
                    <button className="primary-button" onClick={swapNumber} disabled={busy}>
                      {busy ? "正在分配…" : "获取第 2 个号码"}
                    </button>
                  </div>
                ) : order.status === "expired" ? (
                  <div className="replacement-state">
                    <p>第 2 个号码仍未收到短信，已自动释放。本卡密的 2 个号码额度已用完。</p>
                  </div>
                ) : (
                  <div className="waiting-panel">
                    <div className="timer-row">
                      <div>
                        <span>自动查询中</span>
                        <small>每 8 秒检查一次短信</small>
                      </div>
                      <strong>{secondsToSwap ? formatTime(secondsToSwap) : "可换号"}</strong>
                    </div>
                    <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
                    <p>{secondsToSwap
                      ? "倒计时结束后，如仍未收到会自动释放号码"
                      : access?.remainingSwaps
                        ? "正在释放旧号码，随后可获取第 2 个号码"
                        : "正在释放最后一个号码，不会再产生新订单"}</p>
                    <div className="action-grid">
                      <button className="secondary-button" onClick={() => checkCode()} disabled={busy}>立即查询</button>
                      <button className="swap-button" onClick={swapNumber} disabled={busy || !canSwap}>
                        {access?.remainingSwaps ? `更换号码（剩 ${access.remainingSwaps} 次）` : "换号次数已用完"}
                      </button>
                    </div>
                  </div>
                )}

                {order.code && access && access.remainingSuccesses > 0 && (
                  <button className="primary-button next-button" onClick={acquireNumber} disabled={busy}>
                    继续下一次验证
                  </button>
                )}

                {access?.isAdmin && ["waiting", "replacement_pending"].includes(order.status) && (
                  <button className="service-switch-button" onClick={switchService} disabled={busy}>
                    {busy ? "正在结束当前订单…" : "结束当前订单并切换服务"}
                  </button>
                )}

                <div className="order-meta">
                  <span>遇到问题？将订单号发给卖家</span>
                  <button onClick={() => copy(order.id, "order")}>
                    {copied === "order" ? "已复制" : "复制订单号"}
                  </button>
                </div>
              </div>
            )}

            {authenticated && access && !adminOpen && (
              <footer className="quota-bar">
                <span>剩余服务 <b>{access.remainingSuccesses}</b> 次</span>
                <i />
                <span>剩余换号 <b>{access.remainingSwaps}</b> 次</span>
              </footer>
            )}
          </section>

          <div className="privacy-note"><span>●</span> 服务数据加密传输 · 卡密与订单分离存储</div>
        </div>
      </section>

      <footer className="site-footer">
        <span>© 2026 验证码助手</span>
        <p>本服务为第三方独立工具，与目标平台无隶属或官方合作关系。请遵守相关平台规则并合法使用。</p>
      </footer>
    </main>
  );
}
