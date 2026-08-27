-- ============================================================================
-- Migration — Product weight, for auto-selecting a 3-Wheeler on heavy orders
-- Run on the OrderIT Supabase project, after schema.sql.
-- Safe to re-run.
--
-- Hotels ordering more than 20kg total in one go can't reasonably expect a
-- 2-Wheeler to carry it — the checkout now auto-switches the delivery
-- estimate to the 3-Wheeler tier when that happens (see vehicleForWeight()
-- in src/lib/orderFees.js), which needs a per-product weight to sum against
-- the cart.
--
-- Defaults to 1kg per unit, which is correct for any product priced in
-- 'kg'. For products priced in other units (piece, dozen, litre, crate...),
-- update this to the actual per-unit weight so the 20kg threshold is
-- meaningful — there's no product-management screen in this app yet, so for
-- now that's a manual SQL update:
--   update products set weight_kg_per_unit = 0.06 where name = 'Egg' and unit = 'piece';
-- ============================================================================

alter table products add column if not exists weight_kg_per_unit numeric not null default 1;

-- Records the vehicle the checkout auto-selected based on cart weight, for
-- APMC/admin reference — this is informational only. It does NOT restrict
-- what vehicle APMC actually books via DeliveryPanel; they can still pick
-- whichever of 2W/3W is practically available (see DeliveryPanel.jsx) and
-- the fare stays whatever was already fixed on the order at checkout.
alter table orders add column if not exists delivery_vehicle_type text;
