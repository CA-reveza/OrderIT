-- ============================================================================
-- Migration — Revert: keep the platform fee OUT of stored item prices
-- Run on the OrderIT Supabase project, after schema_embed_platform_fee_in_item_price.sql.
-- Safe to re-run.
--
-- The previous migration (schema_embed_platform_fee_in_item_price.sql) baked
-- the 3% fee directly into order_items.unit_price so hotels wouldn't see a
-- separate "Platform fee" line. That was wrong: order_items is the SAME data
-- suppliers/APMC see for their own orders, so it also inflated every price
-- APMC saw by 3% — the fee was showing up on their side too.
--
-- Fix: order_items.unit_price goes back to being the supplier's raw price,
-- always (this is what APMC gets paid on). The 3% is still charged to the
-- hotel — it's applied only in the app's UI layer (hotelItemPrice() in
-- src/lib/orderFees.js) when rendering prices for a hotel viewer, never
-- written to the database. order_total/platform_fee_amount/grand_total go
-- back to the original additive formula (order_total + 3% fee + delivery).
-- ============================================================================

create or replace function recalc_order_total()
returns trigger
security definer
set search_path = public
as $$
declare
  target_order_id uuid;
  new_total numeric;
  fee_pct numeric;
  delivery numeric;
begin
  target_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(line_total), 0) into new_total
  from order_items where order_id = target_order_id;

  select platform_fee_pct, coalesce(delivery_charge, 0) into fee_pct, delivery
  from orders where id = target_order_id;

  update orders
  set order_total = new_total,
      commission_amount = round(new_total * commission_pct / 100, 2),
      gross_contribution = round(new_total * commission_pct / 100, 2) + delivery_contribution,
      platform_fee_amount = round(new_total * coalesce(fee_pct, 3) / 100, 2),
      grand_total = new_total + round(new_total * coalesce(fee_pct, 3) / 100, 2) + delivery,
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
     or new.order_total is distinct from old.order_total
     or new.platform_fee_pct is distinct from old.platform_fee_pct then
    new.platform_fee_amount := round(new.order_total * new.platform_fee_pct / 100, 2);
    new.grand_total := new.order_total + new.platform_fee_amount + coalesce(new.delivery_charge, 0);
  end if;
  return new;
end;
$$;
