-- ============================================================================
-- ⚠️ SUPERSEDED — see schema_revert_embedded_fee_keep_raw_prices.sql, which
-- reverts this. Baking the fee into unit_price turned out to also inflate
-- prices on the supplier/APMC side, which was never the intent — order_items
-- must stay the raw supplier price for both sides to see the truth. Kept
-- here only for history; if you haven't run this yet, skip straight to the
-- revert migration instead (running both back-to-back is also fine, since
-- the revert is what ends up in effect either way).
-- ============================================================================
-- Migration — Fold platform fee into item prices (stop double-charging it)
-- Run on the OrderIT Supabase project, after schema_grand_total_sync_trigger.sql.
-- Safe to re-run.
--
-- Until now, the 3% platform fee was charged as its own line on top of the
-- raw item subtotal (order_total * platform_fee_pct / 100), shown to the
-- hotel as a separate "Platform fee (3%)" row at checkout.
--
-- That's now folded directly into each item's price instead — the app
-- inserts order_items.unit_price already marked up by 3% (see
-- hotelItemPrice() in src/lib/orderFees.js), so order_total itself already
-- includes the fee. Both triggers below must stop adding platform_fee_amount
-- again on top of that, or the hotel would be charged the fee twice.
--
-- platform_fee_pct/platform_fee_amount columns are kept (not dropped) for
-- historical orders placed before this migration, whose grand_total was
-- computed the old way and is left untouched — this only changes the
-- formula for orders whose order_items or delivery_charge change from now
-- on. New orders get platform_fee_amount = 0 going forward, since the fee
-- no longer exists as a separate amount to report.
-- ============================================================================

create or replace function recalc_order_total()
returns trigger
security definer
set search_path = public
as $$
declare
  target_order_id uuid;
  new_total numeric;
  delivery numeric;
begin
  target_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(line_total), 0) into new_total
  from order_items where order_id = target_order_id;

  select coalesce(delivery_charge, 0) into delivery
  from orders where id = target_order_id;

  update orders
  set order_total = new_total,
      commission_amount = round(new_total * commission_pct / 100, 2),
      gross_contribution = round(new_total * commission_pct / 100, 2) + delivery_contribution,
      platform_fee_amount = 0,
      grand_total = new_total + delivery,
      updated_at = now()
  where id = target_order_id;

  return null;
end;
$$ language plpgsql;

create or replace function recalc_grand_total_on_orders_update()
returns trigger
language plpgsql
as $$
begin
  if new.delivery_charge is distinct from old.delivery_charge
     or new.order_total is distinct from old.order_total then
    new.platform_fee_amount := 0;
    new.grand_total := new.order_total + coalesce(new.delivery_charge, 0);
  end if;
  return new;
end;
$$;
