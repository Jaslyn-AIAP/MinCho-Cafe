-- Only needed if schema.sql was run BEFORE free delivery was added (Oct 2026).
-- Supabase → SQL Editor → paste → Run. Safe to run once.
alter table public.settings
  add column if not exists free_delivery_min_cents int not null default 0
  check (free_delivery_min_cents >= 0);
