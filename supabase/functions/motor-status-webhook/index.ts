// supabase/functions/motor-status-webhook/index.ts
//
// Receives a push from MOTOR's own Supabase Database Webhook (configured on
// MOTOR's project, not OrderIT's) every time a booking row changes — most
// importantly, when a driver accepts one. Updates OrderIT's own `deliveries`
// row so it shows up immediately in both the Hotel and Supplier order lists,
// without the browser needing to be looking at that specific order or have
// MOTOR's anon key configured.
//
// This is the server-to-server counterpart to src/components/MotorStatus.jsx
// (which does a lighter client-side live subscription when configured) —
// this webhook is what makes status show up in the compact order-list
// Delivery column reliably, for every viewer, all the time.
//
// Deploy:
//   supabase functions deploy motor-status-webhook --no-verify-jwt
// (--no-verify-jwt because MOTOR's webhook caller has no OrderIT user JWT —
// instead we verify a shared secret header below.)
//
// Secrets (set once, on the OrderIT project):
//   supabase secrets set MOTOR_WEBHOOK_SECRET=some-long-random-string
//
// Then, on the MOTOR project: Database → Webhooks → Create a new webhook
//   Table: bookings   Events: Update
//   Type: HTTP Request → URL: <this function's URL>
//   HTTP Headers: add `x-webhook-secret: <same value as MOTOR_WEBHOOK_SECRET>`

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MOTOR_WEBHOOK_SECRET = Deno.env.get('MOTOR_WEBHOOK_SECRET')

Deno.serve(async (req) => {
  try {
    // Verify this really came from the MOTOR webhook, not a random caller —
    // this function is deployed with --no-verify-jwt (public URL) since
    // MOTOR has no OrderIT session to send.
    if (MOTOR_WEBHOOK_SECRET) {
      const provided = req.headers.get('x-webhook-secret')
      if (provided !== MOTOR_WEBHOOK_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
    }

    const payload = await req.json()
    // Supabase Database Webhooks send { type, table, record, old_record }
    const booking = payload.record
    if (!booking?.id) return new Response(JSON.stringify({ error: 'No booking record in payload' }), { status: 400 })

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const update: Record<string, unknown> = { motor_status: booking.status }
    if (booking.status === 'accepted' && booking.driver_id) {
      // Note: this is MOTOR's driver id, in MOTOR's own auth system — stored
      // here only for display, not linked to an OrderIT profile.
      update.motor_driver_id = booking.driver_id
    }
    if (booking.status === 'picked_up') update.picked_up_at = new Date().toISOString()
    if (booking.status === 'in_transit') update.in_transit_at = new Date().toISOString()
    if (booking.status === 'completed') update.delivered_at = new Date().toISOString()

    const { error } = await admin
      .from('deliveries')
      .update(update)
      .eq('motor_booking_id', booking.id)

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

    // APMC no longer marks orders out for delivery / delivered — MoveIT's
    // driver progress drives it. Moves every order on this booking (more
    // than one if they were clubbed), and only ever forwards, never back.
    const orderStatus =
      booking.status === 'completed' ? 'delivered'
      : (booking.status === 'picked_up' || booking.status === 'in_transit') ? 'out_for_delivery'
      : null
    if (orderStatus) {
      const { data: links } = await admin.from('deliveries').select('order_id').eq('motor_booking_id', booking.id)
      const ids = (links || []).map((l) => l.order_id)
      if (ids.length) {
        const from = orderStatus === 'delivered' ? ['packed', 'out_for_delivery'] : ['packed']
        await admin.from('orders').update({ status: orderStatus }).in('id', ids).in('status', from)
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
