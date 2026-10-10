-- Adds packet/bottle to each size. Only needed if schema.sql was run BEFORE
-- this change (10 Oct 2026). Supabase → SQL Editor → paste → Run. Safe to run once.
alter table public.bottle_sizes add column if not exists container text not null default 'bottle' check (container in ('bottle', 'packet'));
update public.bottle_sizes set container = 'packet' where ml = 250;
