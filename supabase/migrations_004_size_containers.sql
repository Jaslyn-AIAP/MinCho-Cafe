-- =============================================================================
-- Migration 004 (11 Oct 2026): a size is volume + container
-- -----------------------------------------------------------------------------
-- Before: one row per volume, so 500 ml could be a packet OR a bottle.
-- After:  one row per volume + container, so 500 ml packet and 500 ml bottle
--         can both exist and be ticked on or off separately.
-- Existing orders are not touched (each order item already records its container).
--
-- Run once: Supabase → SQL Editor → New query → paste all of this → Run.
-- Safe to run again: it ends in the same state.
-- =============================================================================

-- Step 1: change the key from (ml) to (ml, container)
alter table public.bottle_sizes drop constraint if exists bottle_sizes_pkey;
alter table public.bottle_sizes add constraint bottle_sizes_pkey primary key (ml, container);

-- Step 2: this week's menu, as requested on 11 Oct 2026:
-- 250 ml, 500 ml and 1 L packets on sale; bottles kept but unticked, so the
-- owners can tick them back on in admin → Menu & prices → Sizes.
insert into public.bottle_sizes (ml, container, active) values
  (250, 'packet', true), (500, 'packet', true), (1000, 'packet', true)
on conflict (ml, container) do update set active = true;
update public.bottle_sizes set active = false where container = 'bottle';

-- Check: should list 1 L bottle and 500 ml bottle as false, and three packets as true
select ml, container, active from public.bottle_sizes order by ml, container;
