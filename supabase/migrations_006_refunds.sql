-- =============================================================================
-- Migration 006 (11 Oct 2026): refunds for cancelled orders that were paid
-- -----------------------------------------------------------------------------
-- An order can be cancelled after the customer paid. Before this, the admin
-- page hid that case. Now:
--   * payment has a final step "refunded" (money returned to the customer)
--   * only the PayNow account holder (can_confirm_payments, i.e. QQ) may mark
--     a refund or undo one, and only for a payment confirmed in the bank
--   * who/when of the refund is recorded by the database
-- Existing orders are not changed.
--
-- Run once AFTER migration 005: Supabase -> SQL Editor -> New query -> paste
-- all -> Run. Safe to run again. All or nothing.
-- =============================================================================

begin;

alter table public.orders
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by text;

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'screenshot', 'confirmed', 'refunded'));

-- Same guard as migration 005, extended for refunds
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

  -- Only the PayNow account holder may confirm or refund, or undo either:
  -- both are about money in (or leaving) her bank account
  if new.payment_status is distinct from old.payment_status
     and (new.payment_status in ('confirmed', 'refunded') or old.payment_status in ('confirmed', 'refunded'))
     and not coalesce(may_confirm, false) then
    raise exception 'Only the owner who receives the PayNow money can confirm or refund payments.'
      using errcode = '42501';
  end if;

  -- A refund only makes sense for money confirmed in the bank
  if new.payment_status = 'refunded' and old.payment_status not in ('confirmed', 'refunded') then
    raise exception 'Only a payment confirmed in the bank can be marked refunded. Confirm it first.'
      using errcode = '22023';
  end if;

  -- Who/when are never taken from the browser: start from the stored values...
  new.screenshot_at := old.screenshot_at;  new.screenshot_by := old.screenshot_by;
  new.confirmed_at  := old.confirmed_at;   new.confirmed_by  := old.confirmed_by;
  new.refunded_at   := old.refunded_at;    new.refunded_by   := old.refunded_by;
  new.cancelled_at  := old.cancelled_at;   new.cancelled_by  := old.cancelled_by;

  -- ...then record the step that just happened
  if new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'unpaid' then
      new.screenshot_at := null; new.screenshot_by := null;
      new.confirmed_at  := null; new.confirmed_by  := null;
      new.refunded_at   := null; new.refunded_by   := null;
    elsif new.payment_status = 'screenshot' then
      new.confirmed_at := null; new.confirmed_by := null;
      new.refunded_at  := null; new.refunded_by  := null;
      if old.payment_status = 'unpaid' then new.screenshot_at := now(); new.screenshot_by := who; end if;
    elsif new.payment_status = 'confirmed' then
      new.refunded_at := null; new.refunded_by := null;
      -- undoing a refund keeps the original confirmation record
      if old.payment_status <> 'refunded' then new.confirmed_at := now(); new.confirmed_by := who; end if;
    else -- refunded
      new.refunded_at := now(); new.refunded_by := who;
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

commit;

-- Check: unchanged orders, now with the refund columns
select order_ref, customer_name, total_cents, status, payment_status, refunded_by
  from public.orders order by created_at;
