-- =============================================================================
-- Migration 005 (11 Oct 2026): payment confirmation and collection, with who/when
-- -----------------------------------------------------------------------------
-- Why: a payment screenshot is not payment. In a Singapore case, a buyer sent
-- genuine screenshots of transfers scheduled for "later" that never went
-- through, 161 times over ~3 years, because the seller stopped checking the
-- bank once she trusted the buyer. So:
--   * payment has three steps: unpaid -> screenshot (customer says paid)
--     -> confirmed (seen in the receiving bank account)
--   * only owners marked can_confirm_payments (the PayNow account holder, QQ)
--     may move an order into or out of "confirmed". Enforced HERE, in the
--     database, so it holds even if someone bypasses the admin page.
--   * collected is separate from payment, so "collected, not paid" is visible
--   * every step records who did it and when; the database fills these in,
--     the browser cannot fake them
--
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run.
-- Safe to run again. All or nothing: if any step fails, nothing is changed.
-- Existing orders keep their items, totals, names and numbers; only the new
-- payment/collection columns are filled in (see step 3).
-- AFTER adding QQ as an owner, give her the confirm right (see the end).
-- =============================================================================

begin;

-- 1. Who may confirm payments. Owners cannot change this themselves: they have
--    read-only access to their own admins row. Set it here in the SQL Editor.
alter table public.admins add column if not exists can_confirm_payments boolean not null default false;
-- The name shown in "Confirmed: QQ 2026-10-11 21:40" (falls back to the login email)
alter table public.admins add column if not exists display_name text check (display_name is null or char_length(display_name) between 1 and 30);

-- 2. New order columns
alter table public.orders
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists screenshot_at  timestamptz,
  add column if not exists screenshot_by  text,
  add column if not exists confirmed_at   timestamptz,
  add column if not exists confirmed_by   text,
  add column if not exists collected_at   timestamptz,
  add column if not exists collected_by   text,
  add column if not exists cancelled_at   timestamptz,
  add column if not exists cancelled_by   text;

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'screenshot', 'confirmed'));

-- 3. Carry over existing orders from the old single status.
--    Cautious on purpose: an old "Paid" may have been ticked on a screenshot,
--    so it becomes "Screenshot received" and shows in QQ's list to confirm in
--    her bank. Nothing old is treated as confirmed until QQ says so.
alter table public.orders drop constraint if exists orders_status_check;
update public.orders set payment_status = 'screenshot', screenshot_by = coalesce(screenshot_by, 'Marked Paid before 11 Oct 2026')
  where status in ('paid', 'collected') and payment_status = 'unpaid';
update public.orders set collected_at = coalesce(collected_at, now()), collected_by = coalesce(collected_by, 'before 11 Oct 2026')
  where status = 'collected';
update public.orders set cancelled_at = coalesce(cancelled_at, now()), cancelled_by = coalesce(cancelled_by, 'before 11 Oct 2026')
  where status = 'cancelled';
update public.orders set status = 'active' where status in ('awaiting_payment', 'paid', 'collected');
alter table public.orders alter column status set default 'active';
alter table public.orders add constraint orders_status_check check (status in ('active', 'cancelled'));

-- 4. Guard and stamp every owner update
create or replace function public.orders_guard_and_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  who         text;
  may_confirm boolean;
begin
  -- No logged-in owner: the order-taking server function or the SQL Editor.
  -- Both are trusted and never change these fields, so no checks.
  if auth.uid() is null then
    return new;
  end if;

  select coalesce(a.display_name, a.email), a.can_confirm_payments into who, may_confirm
    from public.admins a where a.user_id = auth.uid();

  -- Only the PayNow account holder may confirm, or undo a confirmation
  if new.payment_status is distinct from old.payment_status
     and 'confirmed' in (new.payment_status, old.payment_status)
     and not coalesce(may_confirm, false) then
    raise exception 'Only the owner who receives the PayNow money can confirm payments.'
      using errcode = '42501';
  end if;

  -- Who/when are never taken from the browser: start from the stored values...
  new.screenshot_at := old.screenshot_at;  new.screenshot_by := old.screenshot_by;
  new.confirmed_at  := old.confirmed_at;   new.confirmed_by  := old.confirmed_by;
  new.cancelled_at  := old.cancelled_at;   new.cancelled_by  := old.cancelled_by;

  -- ...then record the step that just happened
  if new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'unpaid' then
      new.screenshot_at := null; new.screenshot_by := null;
      new.confirmed_at  := null; new.confirmed_by  := null;
    elsif new.payment_status = 'screenshot' then
      new.confirmed_at := null; new.confirmed_by := null;
      if old.payment_status = 'unpaid' then new.screenshot_at := now(); new.screenshot_by := who; end if;
    else -- confirmed
      new.confirmed_at := now(); new.confirmed_by := who;
    end if;
  end if;

  -- Collected: the browser only says yes (any time) or no (null)
  if (new.collected_at is null) <> (old.collected_at is null) then
    if new.collected_at is null then new.collected_by := null;
    else new.collected_at := now(); new.collected_by := who; end if;
  else
    new.collected_at := old.collected_at; new.collected_by := old.collected_by;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'cancelled' then new.cancelled_at := now(); new.cancelled_by := who;
    else new.cancelled_at := null; new.cancelled_by := null; end if;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_guard_and_stamp on public.orders;
create trigger orders_guard_and_stamp before update on public.orders
  for each row execute function public.orders_guard_and_stamp();

commit;

-- 5. Check: owners, and every existing order's new payment/collection state
select email, display_name, can_confirm_payments from public.admins order by created_at;
select order_ref, customer_name, total_cents, status, payment_status, (collected_at is not null) as collected
  from public.orders order by created_at;

-- -----------------------------------------------------------------------------
-- AFTERWARDS (one line each, with the real login emails):
--   Your display name:   update public.admins set display_name = 'Jaslyn' where email = 'your-login@example.com';
--   QQ's confirm right:  update public.admins set can_confirm_payments = true where email = 'qq-login@example.com';
-- Owners added later get their name from the "Name" box when they're added.
-- To check:  select email, display_name, can_confirm_payments from public.admins;
-- -----------------------------------------------------------------------------
