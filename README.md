# 验证码助手

面向终端用户的美国号码验证工具。支持闲鱼卡密、自动收码、倒计时换号、服务次数限制和订单追踪。

## 技术栈

- Next.js 16 / React 19
- Supabase Postgres（仅服务端使用 Secret Key）
- Vercel 部署
- 第三方号码通道 API

## 1. 创建 Supabase 数据表

1. 在 Supabase 创建项目。
2. 打开 SQL Editor。
3. 完整执行 `supabase/schema.sql`。
4. 在 Project Settings → API Keys 获取项目 URL 和 `sb_secret_...` Secret Key。

Secret Key 会绕过 RLS，只能配置在服务端环境变量，绝不能添加 `NEXT_PUBLIC_` 前缀。

## 2. 本地环境变量

```bash
copy .env.example .env.local
```

填写：

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`（旧项目可改用 `SUPABASE_SERVICE_ROLE_KEY`）
- `SMSMAN_API_TOKEN`
- 国家及应用 ID

## 3. Admin 卡密与买家卡密

网站首页是统一卡密入口：

- 输入 Admin 卡密后，会额外显示“卡密管理”菜单。
- 输入普通买家卡密后，只显示接码功能，服务端会拒绝访问管理接口。
- Admin 可在网页中设置备注和有效天数，一键生成并复制买家卡密。
- 普通卡密固定只能成功接码 1 次，最多使用 2 个号码（初始号码 + 换号 1 次）。

完整买家卡密保存在 `access_codes.code_plaintext`，该表启用 RLS，且只授权服务端
`service_role` 访问。浏览器不会直接连接或读取这张表。

也可以在 Supabase SQL Editor 中手动创建普通卡密：

在 Supabase SQL Editor 中执行：

```sql
select * from public.create_access_code(
  'XY-2026-ABCD-EFGH', -- 发给买家的卡密
  '闲鱼订单 123456',   -- 内部备注
  1,                   -- 可成功收码次数
  1,                   -- 可换号次数（固定为 1，总共最多 2 个号码）
  now() + interval '7 days'
);
```

数据库同时保存 SHA-256 摘要用于登录验证，并保存完整买家卡密供 Admin 菜单重新复制。

## 4. 本地运行

```bash
npm install
npm run dev -- -p 3100
```

访问 <http://localhost:3100>。

## 5. 部署到 Vercel

这是一个统一的 Next.js 项目，只需在 Vercel 部署一次。将项目推送到 GitHub，在 Vercel
导入仓库，然后在 Settings → Environment Variables 中添加 `.env.example` 对应变量。

Admin 页面、普通用户页面和所有 `/api` 接口都包含在同一个 Vercel 项目中；Supabase
与 SMS-Man 作为外部服务由服务端环境变量连接。

Vercel 环境变量还需要配置 `CLEANUP_SECRET`。部署得到正式域名后，替换
`supabase/schedule-cleanup.sql` 中的域名和同一密钥，再在 Supabase SQL Editor 执行。
Supabase Cron 会每分钟调用清理接口。号码超过对应服务的等待时间仍未收到短信时，系统会先做最后一次查询，再自动释放。

建议给 Production、Preview 分别使用不同的 Supabase 项目或至少不同卡密数据。环境变量更新后需要重新部署才会生效。

## 订单状态

- `waiting`：等待短信，可在倒计时后换号
- `received`：已收到验证码并消耗一次成功次数
- `swapping`：正在关闭旧号码
- `replacement_pending`：第 1 个号码已释放并扣除唯一一次换号额度，等待用户点击获取第 2 个号码
- `completed`：用户开始下一次服务后，上一笔已完成
- `closed/cancelled/expired/failed`：终止状态

## 售卖规则

- 一张普通卡密只能成功接收 1 次验证码。
- ChatGPT 号码默认等待 3 分钟，SoulAPP 默认等待 10 分钟；普通卡密最多换 1 次，因此总共最多使用 2 个号码。
- 换号必须先成功 `reject` 旧号码，失败时不购买新号且不扣换号次数。
- 页面每 8 秒自动查询验证码，“立即查询”只是额外手动查询。
- 号码超过对应服务的等待时间仍未收到验证码时自动释放；第 1 个释放后由用户点击获取第 2 个，第 2 个释放后服务结束。

## 安全设计

- 供应商 Token、Supabase Secret Key 均只在服务端读取。
- 用户使用 HttpOnly、SameSite=Strict Cookie，不在 localStorage 保存订单或验证码。
- 所有号码接口检查会话和订单归属。
- 卡密兑换、取号、换号均有数据库限流。
- Supabase 表启用 RLS 且不向匿名角色开放策略。
- 前端不返回供应商地址、余额或原始错误信息。

## 上线前检查

- 实测供应商取消号码和退款规则。
- 根据真实成本设置卡密售价与换号次数。
- 配置自定义域名和售后联系方式。
- 定期清理过期会话、订单和限流记录。
- 明确告知用户本工具不是目标平台官方产品，并要求合规使用。
