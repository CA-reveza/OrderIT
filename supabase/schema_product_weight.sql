-- ============================================================================
-- Migration — Product weight, for auto-selecting a 3-Wheeler on heavy orders
-- Run on the OrderIT Supabase project, after schema.sql. Safe to re-run.
--
-- Orders over 20kg can't reasonably go on a 2-Wheeler, so checkout switches
-- the delivery estimate to the 3-Wheeler tier (vehicleForWeight() in
-- src/lib/orderFees.js). Cart weight is calculated AUTOMATICALLY from each
-- item's unit and quantity — nothing to maintain per product. The column
-- below is just an optional override for products whose unit doesn't map to
-- a weight, e.g.:
--   update products set weight_kg_per_unit = 0.06 where name = 'Egg' and unit = 'piece';
-- ============================================================================

alter table products add column if not exists weight_kg_per_unit numeric;
-- Weight is now worked out automatically from each product's unit (kg, litre,
-- bunch...) in src/lib/orderFees.js, so this column is only an optional
-- per-product override. Earlier versions of this migration defaulted it to 1,
-- which wrongly counted e.g. a bunch of coriander as 1kg — clear those.
alter table products alter column weight_kg_per_unit drop not null;
alter table products alter column weight_kg_per_unit drop default;
update products set weight_kg_per_unit = null where weight_kg_per_unit = 1;

-- Records the vehicle the checkout auto-selected based on cart weight, for
-- APMC/admin reference — this is informational only. It does NOT restrict
-- what vehicle APMC actually books via DeliveryPanel; they can still pick
-- whichever of 2W/3W is practically available (see DeliveryPanel.jsx) and
-- the fare stays whatever was already fixed on the order at checkout.
alter table orders add column if not exists delivery_vehicle_type text;
