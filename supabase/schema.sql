-- =============================================================================
-- MinCho Cafe — database schema for Supabase (PostgreSQL)
-- =============================================================================
-- HOW TO RUN
--   Supabase dashboard → your project → SQL Editor → New query →
--   paste this whole file → Run.
--   The script is safe to run once on a NEW project. Re-running it will fail on
--   "already exists" errors — that is intentional, so nothing is overwritten by
--   accident. For later changes, write a small migration instead.
--
-- SECURITY MODEL (read this before changing anything)
--   1. Every table has Row Level Security (RLS) switched ON.
--   2. The public ("anon") role gets NO policies → it can read/write nothing.
--      Customers never talk to the database directly. Their orders go through
--      the Cloudflare server function, which uses the secret service-role key
--      (stored only in Cloudflare, never in the browser).
--   3. Logged-in users can only read/write if their user id is in `admins`.
--      Public sign-up must be DISABLED in Supabase Auth settings (see README),
--      otherwise strangers could create accounts — they still would not be
--      admins, but there is no reason to allow it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Admins: which Supabase Auth users are shop owners (Ming Ming, QQ, Jaslyn)
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

-- Helper used by every policy. SECURITY DEFINER lets it read `admins` even
-- though `admins` itself is protected by RLS. `set search_path` prevents a
-- known search-path hijacking issue with SECURITY DEFINER functions.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Settings: one single row (id = 1) holding everything the owners can toggle
-- ---------------------------------------------------------------------------
create table public.settings (
  id                  int primary key default 1 check (id = 1),  -- enforce single row
  shop_name           text    not null default 'MinCho Cafe',
  ordering_open       boolean not null default true,   -- master on/off switch
  invite_code         text    not null,                -- shared code customers enter
  delivery_enabled    boolean not null default false,  -- also controls address collection
  delivery_fee_cents  int     not null default 0 check (delivery_fee_cents >= 0),  -- charged below the free-delivery amount
  free_delivery_min_cents int not null default 0 check (free_delivery_min_cents >= 0), -- orders from this amount deliver free; 0 = never free
  min_order_cents     int     not null default 0 check (min_order_cents >= 0),
  cutoff_days         int     not null default 1 check (cutoff_days between 0 and 14),
  cutoff_time         time    not null default '23:59', -- Singapore time
  paynow_number       text    not null,
  collection_note     text    not null default 'Self-collection at QQ''s place. Address is in the WhatsApp group.',
  retention_days      int     not null default 90 check (retention_days between 7 and 730),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Products and bottle sizes. Price is per litre; bottle price is pro-rata.
-- Stored in cents to avoid floating-point rounding errors with money.
-- ---------------------------------------------------------------------------
create table public.products (
  id                    text primary key,              -- e.g. 'milk_tea'
  name                  text not null,
  description           text not null default '',
  price_per_litre_cents int  not null check (price_per_litre_cents > 0),
  active                boolean not null default true,
  sort_order            int  not null default 0
);

-- Sizes on sale. A size is a volume (in ml) AND a container: 500 ml packet and
-- 500 ml bottle are two different sizes. Prices depend on volume only (per litre).
create table public.bottle_sizes (
  ml        int not null check (ml > 0 and ml <= 5000),
  container text not null default 'bottle' check (container in ('bottle', 'packet')),
  active    boolean not null default true,
  constraint bottle_sizes_pkey primary key (ml, container)
);

-- ---------------------------------------------------------------------------
-- Delivery / collection dates the owners open for ordering
-- ---------------------------------------------------------------------------
create table public.delivery_dates (
  id            bigint generated always as identity primary key,
  delivery_date date not null unique,
  active        boolean not null default true,
  note          text not null default '',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Orders
-- `items` is a snapshot (JSON) of what was ordered AND the unit prices at the
-- time of ordering, so changing prices later never rewrites old orders.
-- ---------------------------------------------------------------------------
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  order_ref          text not null unique,               -- e.g. MC1017-K7QF
  delivery_date_id   bigint not null references public.delivery_dates (id) on delete restrict,
  customer_name      text not null check (char_length(customer_name) between 1 and 80),
  phone              text not null check (phone ~ '^[89][0-9]{7}$'),    -- Singapore mobile (8xxx xxxx or 9xxx xxxx)
  fulfilment         text not null check (fulfilment in ('collection', 'delivery')),
  address            text check (address is null or char_length(address) <= 300),
  notes              text not null default '' check (char_length(notes) <= 500),
  items              jsonb not null,
  subtotal_cents     int not null check (subtotal_cents >= 0),
  delivery_fee_cents int not null default 0 check (delivery_fee_cents >= 0),
  total_cents        int not null check (total_cents >= 0),
  status             text not null default 'awaiting_payment'
                     check (status in ('awaiting_payment', 'paid', 'collected', 'cancelled')),
  pdpa_consent       boolean not null check (pdpa_consent = true),
  ip_hash            text,                               -- salted hash, only for rate limiting
  created_at         timestamptz not null default now(),
  -- an address must exist for delivery orders, and must NOT be kept for collection orders
  constraint address_matches_fulfilment check (
    (fulfilment = 'delivery'   and address is not null and char_length(address) > 0) or
    (fulfilment = 'collection' and address is null)
  )
);

create index orders_delivery_date_idx on public.orders (delivery_date_id);
create index orders_rate_limit_idx    on public.orders (ip_hash, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.admins         enable row level security;
alter table public.settings       enable row level security;
alter table public.products       enable row level security;
alter table public.bottle_sizes   enable row level security;
alter table public.delivery_dates enable row level security;
alter table public.orders         enable row level security;

-- Admins can see their own admin row (used by the admin page to confirm access)
create policy "admins read own row" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- Full management rights for admins on the business tables
create policy "admin all settings"       on public.settings       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all products"       on public.products       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all bottle_sizes"   on public.bottle_sizes   for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin all delivery_dates" on public.delivery_dates for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Orders: admins can read, update status, and delete. Inserts only happen via
-- the server function (service role bypasses RLS), so no insert policy here.
create policy "admin read orders"   on public.orders for select to authenticated using (public.is_admin());
create policy "admin update orders" on public.orders for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete orders" on public.orders for delete to authenticated using (public.is_admin());

-- Belt and braces: the public role gets no table privileges at all.
revoke all on public.admins, public.settings, public.products, public.bottle_sizes,
              public.delivery_dates, public.orders from anon;
grant select, insert, update, delete on public.settings, public.products, public.bottle_sizes,
              public.delivery_dates, public.orders to authenticated;
grant select on public.admins to authenticated;
grant all on public.admins, public.settings, public.products, public.bottle_sizes,
             public.delivery_dates, public.orders to service_role;

-- ---------------------------------------------------------------------------
-- Data retention (Personal Data Protection Act: don't keep personal data
-- longer than needed). Admin page has a button that calls this.
-- Deletes orders whose delivery date is older than `retention_days`.
-- ---------------------------------------------------------------------------
create or replace function public.purge_old_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  if not public.is_admin() then
    raise exception 'not authorised';
  end if;

  delete from public.orders o
  using public.delivery_dates d, public.settings s
  where o.delivery_date_id = d.id
    and s.id = 1
    and d.delivery_date < (now() at time zone 'Asia/Singapore')::date - s.retention_days;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function public.purge_old_orders() from public, anon;
grant execute on function public.purge_old_orders() to authenticated;

-- ---------------------------------------------------------------------------
-- Starting data
-- The real PayNow number is NOT kept in this file (the code is in a public
-- repository). Ordering starts CLOSED, so the shop cannot take orders with the
-- placeholder number. After setup, in the admin page → Settings:
--   1. enter the real PayNow number, 2. Make a new code, 3. tick Ordering open.
-- ---------------------------------------------------------------------------
insert into public.settings (id, invite_code, paynow_number, ordering_open)
values (1, 'CHANGE-ME-' || substr(md5(random()::text), 1, 6), '80000000', false);

insert into public.products (id, name, description, price_per_litre_cents, sort_order) values
  ('milk_tea',  'Hong Kong Milk Tea', 'Hand-brewed, silky and strong', 1800, 1),
  ('lemon_tea', 'Hong Kong Lemon Tea', 'Hand-brewed with fresh lemon',  1200, 2);

insert into public.bottle_sizes (ml, container) values (250, 'packet'), (500, 'packet'), (1000, 'packet');

insert into public.delivery_dates (delivery_date) values ('2026-10-17'), ('2026-10-24');
