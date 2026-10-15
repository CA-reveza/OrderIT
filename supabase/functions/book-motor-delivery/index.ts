// supabase/functions/book-motor-delivery/index.ts
//
// Bridges an OrderIT delivery to a real booking in the separate MOTOR app.
// MOTOR is a different Supabase project with its own auth — OrderIT users
// don't have MOTOR accounts, so this Edge Function uses MOTOR's
// *service-role* key (bypassing MOTOR's RLS) to insert the booking directly.
// MOTOR's existing driver console then picks it up exactly like any other
// pending booking — no changes needed on the MOTOR side beyond the
// RUN_ON_MOTOR_PROJECT_bridge.sql migration.
//
// Deploy:
//   supabase functions deploy book-motor-delivery
// Secrets (set once, on the OrderIT project):
//   supabase secrets set MOTOR_SUPABASE_URL=https://xxxx.supabase.co MOTOR_SERVICE_ROLE_KEY=xxx

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MOTOR_SUPABASE_URL = Deno.env.get('MOTOR_SUPABASE_URL')!
const MOTOR_SERVICE_ROLE_KEY = Deno.env.get('MOTOR_SERVICE_ROLE_KEY')!

// Recognized vehicle types — validated only if one is actually sent.
// vehicle_type is now OPTIONAL: APMC no longer picks a vehicle when booking
// (just "Book via MoveIT"), so most requests omit it entirely and the
// booking lands in MOTOR with vehicle_type = null, invisible to any
// driver's job feed until MOTOR's own admin assigns 2W vs 3W from
// AdminDashboard (see motor_orderit_vehicle_optional_migration.sql).
const KNOWN_VEHICLE_TYPES = new Set(['bike', 'three_wheeler', 'pickup', 'mini_truck', 'large_truck'])

// Mirrors MOTOR's own bookings_orderit_max_distance CHECK constraint.
// Checking it here too means a stray >20km booking attempt fails with a
// clear message instead of an opaque "MOTOR booking failed" 502 from the
// insert hitting that constraint on the other project.
const MAX_ORDERIT_DELIVERY_KM = 20

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()
    // Accepts either the original single `order_id`, or `order_ids` (an
    // array) for clubbing 2+ orders from the same supplier into one MoveIT
    // trip. Both normalize to the same `orderIds` array below so the rest
    // of the function doesn't need to care which one was sent.
    const orderIds: string[] = Array.isArray(body.order_ids) && body.order_ids.length
      ? body.order_ids
      : (body.order_id ? [body.order_id] : [])
    const { vehicle_type } = body

    if (!orderIds.length) return json({ error: 'order_id (or order_ids) is required' }, 400)
    if (vehicle_type && !KNOWN_VEHICLE_TYPES.has(vehicle_type)) return json({ error: 'Unknown vehicle_type' }, 400)

    // Act as the calling user (respects OrderIT's RLS) to confirm they can
    // actually see every order before we book anything on their behalf.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    })
    const { data: orders, error: orderErr } = await userClient
      .from('orders')
      .select('id, status, payment_status, supplier_id, delivery_charge, delivery_distance_km, delivery_vehicle_type, delivery_address, hotels(name, address), suppliers(name, apmc_yard, address), order_items(quantity, unit_price, products(name, unit))')
      .in('id', orderIds)
    if (orderErr || !orders || orders.length !== orderIds.length) {
      return json({ error: 'One or more orders not found or not accessible' }, 404)
    }

    // Clubbing only makes sense within one supplier's own pickup run.
    const supplierIds = new Set(orders.map((o) => o.supplier_id))
    if (supplierIds.size > 1) {
      return json({ error: 'Clubbed orders must all be from the same supplier' }, 400)
    }

    // Same gates DeliveryPanel.jsx enforces in the UI — checked again here
    // server-side, for every order, so this can't be bypassed by calling
    // the function directly.
    for (const order of orders) {
      if (order.payment_status !== 'paid') {
        return json({ error: `Order ${order.id.slice(0, 8)} must be paid before a delivery can be booked` }, 400)
      }
      if (!['packed', 'out_for_delivery', 'delivered'].includes(order.status)) {
        return json({ error: `Order ${order.id.slice(0, 8)} must be packed before a delivery can be booked` }, 400)
      }
    }

    // Distance defaults to what was fixed at checkout (the trip itself is
    // booked automatically when APMC marks an order packed, so nobody types
    // it in); an explicit distance_km in the request still wins.
    const distance_km = Number(body.distance_km)
      || Math.max(...orders.map((o) => Number(o.delivery_distance_km) || 0))
      || 5
    if (distance_km > MAX_ORDERIT_DELIVERY_KM) {
      return json({ error: `Distance can't exceed ${MAX_ORDERIT_DELIVERY_KM}km for OrderIT deliveries` }, 400)
    }

    // Idempotent: auto-booking on "packed" and an admin's manual retry must
    // never create two MoveIT bookings for the same order.
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data: existing } = await adminClient
      .from('deliveries')
      .select('order_id, motor_booking_id')
      .in('order_id', orderIds)
      .not('motor_booking_id', 'is', null)
    if (existing?.length) {
      return json({ motor_booking_id: existing[0].motor_booking_id, already_booked: true, orders_clubbed: orders.length })
    }

    const isClubbed = orders.length > 1
    // The fare is always the sum of what was already fixed on each order at
    // checkout — never recomputed from distance/vehicle here, clubbed or
    // not. "The rates is as usual": clubbing changes how many trips APMC
    // makes, not what any individual order was charged for delivery.
    const fare = orders.reduce((sum, o) => sum + (Number(o.delivery_charge) || 0), 0)
    const first = orders[0]
    const pickup = first.suppliers?.address || first.suppliers?.apmc_yard || first.suppliers?.name || 'Supplier'
    const drop = isClubbed
      ? `${orders.length} orders: ${orders.map((o) => o.hotels?.name || o.delivery_address || o.id.slice(0, 8)).join(', ')}`
      : (first.delivery_address || first.hotels?.address || first.hotels?.name || 'Hotel')

    // What MoveIT's backend gets with the alert: order number, the goods, and
    // their price (supplier's own rate x quantity — the goods value, nothing
    // about hotel-side fees). One entry per order when clubbed.
    const orderDetails = {
      orders: orders.map((o) => {
        const items = (o.order_items || []).map((it) => ({
          name: it.products?.name,
          unit: it.products?.unit,
          quantity: Number(it.quantity),
          rate: Number(it.unit_price),
          amount: Math.round(Number(it.quantity) * Number(it.unit_price) * 100) / 100
        }))
        return {
          order_number: `#${o.id.slice(0, 8)}`,
          hotel: o.hotels?.name || null,
          items,
          goods_total: Math.round(items.reduce((sum, i) => sum + i.amount, 0) * 100) / 100
        }
      })
    }
    const goodsText = orderDetails.orders.map((o) =>
      `${o.order_number}: ${o.items.map((i) => `${i.name} ${i.quantity}${i.unit} @₹${i.rate}`).join(', ')} = ₹${o.goods_total}`
    ).join(' | ')

    // Insert the real booking into MOTOR's own database with MOTOR's
    // service-role key — this is what makes it show up in MOTOR's driver
    // console exactly like any other job, once an admin assigns a vehicle.
    // One booking regardless of how many orders are clubbed into it.
    const motorClient = createClient(MOTOR_SUPABASE_URL, MOTOR_SERVICE_ROLE_KEY)
    const bookingRow = {
      customer_id: null,
      pickup_address: pickup,
      drop_address: drop,
      distance_km: Number(distance_km),
      vehicle_type: vehicle_type || null,
      fare_estimate: fare,
      status: 'pending',
      notes: (isClubbed
        ? `OrderIT clubbed delivery — ${orders.length} orders: ${orders.map((o) => `#${o.id.slice(0, 8)}`).join(', ')}`
        : `OrderIT order #${first.id.slice(0, 8)}`)
        // Hint for MoveIT admin when segregating 2W/3W — based on cart weight at checkout.
        + (orders.some((o) => o.delivery_vehicle_type === 'three_wheeler') ? ' · Suggested: 3-Wheeler (over 20kg)' : ''),
      source: 'orderit',
      external_order_id: first.id // primary/first order — the others are linked via deliveries.motor_booking_id below
    }
    let { data: booking, error: motorErr } = await motorClient
      .from('bookings')
      .insert({ ...bookingRow, order_details: orderDetails })
      .select()
      .single()
    // If MOTOR hasn't had motor_orderit_order_details_migration.sql run yet,
    // don't lose the booking — retry with the same details as plain text in notes.
    if (motorErr && /order_details/.test(motorErr.message)) {
      ;({ data: booking, error: motorErr } = await motorClient
        .from('bookings')
        .insert({ ...bookingRow, notes: `${bookingRow.notes} — ${goodsText}` })
        .select()
        .single())
    }

    if (motorErr) return json({ error: `MOTOR booking failed: ${motorErr.message}` }, 502)

    // Mirror the booking back onto OrderIT's own deliveries rows so the
    // OrderIT UI has something to query without hitting MOTOR every time.
    // One deliveries row per order, ALL sharing the same motor_booking_id —
    // that's what makes clubbing work without any new tables: MOTOR's
    // status webhook (motor-status-webhook) already updates
    // `deliveries where motor_booking_id = ...`, so every clubbed order's
    // status updates together automatically as the driver progresses.
    // Note: each order's own delivery_charge is deliberately left
    // untouched — it stays exactly what was charged to the hotel at
    // checkout, regardless of how many orders end up riding together.
    await adminClient.from('deliveries').upsert(
      orders.map((order) => ({
        order_id: order.id,
        delivery_type: 'direct',
        fulfilled_via: 'motor',
        vehicle_type: vehicle_type || null,
        distance_km: Number(distance_km),
        fare_estimate: Number(order.delivery_charge) || 0,
        motor_booking_id: booking.id,
        motor_status: booking.status,
        requested_at: new Date().toISOString()
      })),
      { onConflict: 'order_id' }
    )

    return json({ motor_booking_id: booking.id, fare_estimate: fare, orders_clubbed: orders.length, status: booking.status })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}
