-- ============================================================================
-- Migration — Cap delivery distance at 20km + update pricing docs
-- Run on the OrderIT Supabase project, after schema_platform_fee_and_delivery_formula.sql.
-- Safe to re-run.
--
-- Delivery pricing was updated to mirror MoveIT's own 2-Wheeler tier exactly
-- (MoveIT_Final_2W_3W_Price_List.xlsx): ₹90 base up to 5km, +₹20/km beyond
-- that, +₹20 flat platform charge, capped at 20km. The formula itself lives
-- client-side in src/lib/orderFees.js (delivery_charge is still just passed
-- in at order creation, same as before) — this migration only adds the
-- matching CHECK constraint, so a >20km order can't be created in the first
-- place rather than failing later when book-motor-delivery tries to bridge
-- it to MOTOR (which enforces the same 20km cap on its own bookings table).
-- ============================================================================

alter table orders drop constraint if exists orders_delivery_max_distance;
alter table orders add constraint orders_delivery_max_distance
  check (delivery_distance_km is null or delivery_distance_km <= 20);
