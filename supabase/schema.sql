create extension if not exists pgcrypto;

create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  code_hint text not null,
  code_plaintext text,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  label text,
  max_successes integer not null default 1 check (max_successes > 0),
  successes_used integer not null default 0 check (successes_used >= 0),
  max_swaps integer not null default 1 check (max_swaps >= 0),
  swaps_used integer not null default 0 check (swaps_used >= 0),
  expires_at timestamptz not null default (now() + interval '30 days'),
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.access_codes
  add column if not exists code_plaintext text;
alter table public.access_codes
  add column if not exists role text not null default 'customer';

update public.access_codes
set max_successes = 1
where role = 'customer' and max_successes <> 1;

update public.access_codes
set max_swaps = 1,
    swaps_used = least(swaps_used, 1)
where role = 'customer' and (max_swaps <> 1 or swaps_used > 1);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'access_codes_role_check'
      and conrelid = 'public.access_codes'::regclass
  ) then
    alter table public.access_codes
      add constraint access_codes_role_check check (role in ('customer', 'admin'));
  end if;
end;
$$;

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid not null references public.access_codes(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sms_orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  provider_request_id text not null unique,
  phone text not null,
  cost numeric(12, 4) not null default 0,
  status text not null default 'waiting' check (
    status in (
      'waiting', 'received', 'completed', 'swapping', 'replacement_pending',
      'closed', 'cancelled', 'expired', 'failed'
    )
  ),
  sms_code text,
  can_swap_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rate_limits (
  key text primary key,
  hits integer not null default 0,
  window_started_at timestamptz not null default now()
);

create index if not exists user_sessions_access_code_idx
  on public.user_sessions(access_code_id, created_at desc);
create index if not exists sms_orders_session_idx
  on public.sms_orders(session_id, created_at desc);
create index if not exists sms_orders_active_idx
  on public.sms_orders(session_id, status)
  where status in ('waiting', 'received', 'swapping', 'replacement_pending');

alter table public.access_codes enable row level security;
alter table public.user_sessions enable row level security;
alter table public.sms_orders enable row level security;
alter table public.rate_limits enable row level security;

create or replace function public.create_access_code(
  p_code text,
  p_label text default null,
  p_max_successes integer default 1,
  p_max_swaps integer default 1,
  p_expires_at timestamptz default (now() + interval '30 days')
)
returns table(id uuid, code_hint text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(trim(p_code));
begin
  if length(v_code) < 8 then
    raise exception 'access code must contain at least 8 characters';
  end if;

  return query
  insert into public.access_codes (
    code_hash, code_hint, code_plaintext, role, label,
    max_successes, max_swaps, expires_at
  ) values (
    encode(extensions.digest(v_code, 'sha256'), 'hex'),
    right(v_code, 4),
    v_code,
    'customer',
    nullif(trim(p_label), ''),
    1,
    1,
    p_expires_at
  )
  returning access_codes.id, access_codes.code_hint;
end;
$$;

create or replace function public.redeem_access_code(
  p_code text,
  p_session_hash text,
  p_session_expires_at timestamptz
)
returns table(session_id uuid, access_code_id uuid, expires_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_access public.access_codes%rowtype;
  v_session_id uuid;
  v_expires_at timestamptz;
begin
  select * into v_access
  from public.access_codes
  where code_hash = encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex')
  for update;

  if v_access.id is null
    or v_access.disabled
    or v_access.expires_at <= now()
    or (v_access.role <> 'admin' and v_access.successes_used >= v_access.max_successes) then
    return;
  end if;

  v_expires_at := least(p_session_expires_at, v_access.expires_at);

  insert into public.user_sessions(access_code_id, token_hash, expires_at)
  values (v_access.id, p_session_hash, v_expires_at)
  returning id into v_session_id;

  -- 同一卡密只保留一个有效会话，并把已有订单交接给最新设备。
  update public.sms_orders as orders
  set session_id = v_session_id, updated_at = now()
  where orders.session_id in (
    select sessions.id from public.user_sessions as sessions
    where sessions.access_code_id = v_access.id and sessions.id <> v_session_id
  );

  update public.user_sessions as sessions
  set revoked_at = now()
  where sessions.access_code_id = v_access.id
    and sessions.id <> v_session_id
    and sessions.revoked_at is null;

  return query select v_session_id, v_access.id, v_expires_at;
end;
$$;

create or replace function public.take_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits as limits(key, hits, window_started_at)
  values (p_key, 1, now())
  on conflict (key) do update set
    hits = case
      when limits.window_started_at < now() - make_interval(secs => p_window_seconds)
        then 1
      else limits.hits + 1
    end,
    window_started_at = case
      when limits.window_started_at < now() - make_interval(secs => p_window_seconds)
        then now()
      else limits.window_started_at
    end
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

create or replace function public.complete_sms_order(
  p_order_id uuid,
  p_sms_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_status text;
  v_access_code_id uuid;
begin
  select session_id, status into v_session_id, v_status
  from public.sms_orders
  where id = p_order_id
  for update;

  if v_session_id is null or v_status <> 'waiting' then
    return false;
  end if;

  select access_code_id into v_access_code_id
  from public.user_sessions
  where id = v_session_id;

  update public.sms_orders
  set status = 'received', sms_code = p_sms_code, updated_at = now()
  where id = p_order_id;

  update public.access_codes
  set successes_used = least(max_successes, successes_used + 1), updated_at = now()
  where id = v_access_code_id;

  return true;
end;
$$;

create or replace function public.begin_sms_swap(p_order_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_access_code_id uuid;
  v_status text;
  v_can_swap_at timestamptz;
  v_swaps_used integer;
  v_max_swaps integer;
begin
  select sessions.access_code_id, orders.status, orders.can_swap_at,
         codes.swaps_used, codes.max_swaps
  into v_access_code_id, v_status, v_can_swap_at, v_swaps_used, v_max_swaps
  from public.sms_orders orders
  join public.user_sessions sessions on sessions.id = orders.session_id
  join public.access_codes codes on codes.id = sessions.access_code_id
  where orders.id = p_order_id
  for update of orders, codes;

  if v_access_code_id is null
    or v_status <> 'waiting'
    or v_can_swap_at > now()
    or v_swaps_used >= v_max_swaps then
    return false;
  end if;

  update public.sms_orders
  set status = 'swapping', updated_at = now()
  where id = p_order_id;

  update public.access_codes
  set swaps_used = swaps_used + 1, updated_at = now()
  where id = v_access_code_id;

  return true;
end;
$$;

create or replace function public.rollback_sms_swap(
  p_order_id uuid,
  p_status text default 'waiting',
  p_refund_swap boolean default true
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_access_code_id uuid;
begin
  if p_status not in ('waiting', 'replacement_pending', 'closed') then
    raise exception 'invalid rollback status';
  end if;

  select sessions.access_code_id into v_access_code_id
  from public.sms_orders orders
  join public.user_sessions sessions on sessions.id = orders.session_id
  where orders.id = p_order_id and orders.status = 'swapping'
  for update of orders;

  if v_access_code_id is null then
    return false;
  end if;

  update public.sms_orders
  set status = p_status, updated_at = now()
  where id = p_order_id;

  if p_refund_swap then
    update public.access_codes
    set swaps_used = greatest(0, swaps_used - 1), updated_at = now()
    where id = v_access_code_id;
  end if;

  return true;
end;
$$;

revoke all on function public.create_access_code(text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.redeem_access_code(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.take_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_sms_order(uuid, text) from public, anon, authenticated;
revoke all on function public.begin_sms_swap(uuid) from public, anon, authenticated;
revoke all on function public.rollback_sms_swap(uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.create_access_code(text, text, integer, integer, timestamptz) to service_role;
grant execute on function public.redeem_access_code(text, text, timestamptz) to service_role;
grant execute on function public.take_rate_limit(text, integer, integer) to service_role;
grant execute on function public.complete_sms_order(uuid, text) to service_role;
grant execute on function public.begin_sms_swap(uuid) to service_role;
grant execute on function public.rollback_sms_swap(uuid, text, boolean) to service_role;

revoke all on table public.access_codes from anon, authenticated;
revoke all on table public.user_sessions from anon, authenticated;
revoke all on table public.sms_orders from anon, authenticated;
revoke all on table public.rate_limits from anon, authenticated;

grant select, insert, update, delete on table public.access_codes to service_role;
grant select, insert, update, delete on table public.user_sessions to service_role;
grant select, insert, update, delete on table public.sms_orders to service_role;
grant select, insert, update, delete on table public.rate_limits to service_role;
