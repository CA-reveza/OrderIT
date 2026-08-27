// Delivery pricing per vehicle — mirrors MoveIT's own tiers exactly
// (MoveIT_Final_2W_3W_Price_List.xlsx / MoveIT's src/lib/pricing.js
// ORDERIT_VEHICLE_TIERS), so what the hotel is charged at checkout matches
// what MoveIT computes as the delivery gross on its side, whichever vehicle
// ends up being used. Continuous per-km (not rounded up per partial km) —
// MoveIT's tier is continuous, so this stays continuous too rather than
// drifting from it on fractional distances.
export const BASE_DELIVERY_KM = 5
export const MAX_DELIVERY_KM = 20

export const VEHICLE_TIERS = {
  bike: { label: 'Two-Wheeler', baseCharge: 90, perKmAfter: 20, driverPct: 70 },
  three_wheeler: { label: '3-Wheeler', baseCharge: 125, perKmAfter: 35, driverPct: 80 }
}

// Back-compat aliases for the 2-Wheeler tier — most of the app still
// defaults to this vehicle unless weight forces a 3-Wheeler (see
// vehicleForWeight below).
export const BASE_DELIVERY_CHARGE = VEHICLE_TIERS.bike.baseCharge
export const PER_KM_CHARGE = VEHICLE_TIERS.bike.perKmAfter

// Flat delivery-side platform charge, on top of the distance-based delivery
// charge above — this is MoveIT's cut for facilitating the delivery leg.
// It's separate from PLATFORM_FEE_PCT below, which is OrderIT's own
// commission on the food/APMC order subtotal and has nothing to do with
// delivery — the two charges are unrelated and both apply.
export const DELIVERY_PLATFORM_CHARGE = 20

// A single order above this weight can't physically go on a 2-Wheeler, so
// the app auto-selects a 3-Wheeler instead of asking the hotel to guess.
export const AUTO_3W_WEIGHT_KG = 20

export function vehicleForWeight(totalWeightKg) {
  return Number(totalWeightKg) > AUTO_3W_WEIGHT_KG ? 'three_wheeler' : 'bike'
}

export function deliveryCharge(km, vehicleTypeId = 'bike') {
  const tier = VEHICLE_TIERS[vehicleTypeId] || VEHICLE_TIERS.bike
  const distance = Number(km)
  // No such thing as free delivery — a missing/invalid/zero distance still
  // charges the base rate rather than defaulting to ₹0.
  if (!distance || distance <= BASE_DELIVERY_KM) return tier.baseCharge
  const capped = Math.min(distance, MAX_DELIVERY_KM)
  return tier.baseCharge + (capped - BASE_DELIVERY_KM) * tier.perKmAfter
}

// The full delivery-line total shown at checkout and stored as
// orders.delivery_charge — distance-based charge + the flat platform
// charge. This is the number that ends up as a MoveIT booking's
// fare_estimate when a vehicle is later booked via book-motor-delivery, so
// it needs to already include everything MoveIT itself would charge.
export function totalDeliveryCharge(km, vehicleTypeId = 'bike') {
  return deliveryCharge(km, vehicleTypeId) + DELIVERY_PLATFORM_CHARGE
}

export const PLATFORM_FEE_PCT = 3

export function platformFee(subtotal) {
  return Math.round(Number(subtotal) * PLATFORM_FEE_PCT) / 100
}

// Hotel/customer-facing item price: the supplier's raw listed price with the
// platform fee folded directly into it, rounded to 2 decimals. Hotels see
// this marked-up number as "the" price, per-item, in every hotel-facing
// view (product list, cart, quote comparisons, order history) — this is a
// DISPLAY-ONLY helper, never written to order_items.unit_price, which stays
// the supplier's raw price so APMC/suppliers keep seeing their own true
// numbers (see schema_revert_embedded_fee_keep_raw_prices.sql).
export function hotelItemPrice(rawPrice) {
  return Math.round(Number(rawPrice) * (100 + PLATFORM_FEE_PCT)) / 100
}
