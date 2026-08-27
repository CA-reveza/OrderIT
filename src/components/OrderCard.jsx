import { useState } from 'react'
import { supabase } from '../supabaseClient'
import PaymentButton from './PaymentButton'
import DeliveryPanel from './DeliveryPanel'
import OrderTrackingStepper from './OrderTrackingStepper'
import { downloadInvoice } from '../lib/invoice'
import { hotelItemPrice } from '../lib/orderFees'

const STATUS_FLOW = {
  pending: ['accepted', 'rejected'],
  accepted: ['packed'],
  packed: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  rejected: [],
  cancelled: []
}

const STATUS_LABEL = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  packed: 'Packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
}

export default function OrderCard({ order, viewerRole, onChanged, onBack }) {
  const [busy, setBusy] = useState(false)
  const delivery = Array.isArray(order.deliveries) ? order.deliveries[0] : order.deliveries

  const updateStatus = async (status) => {
    setBusy(true)
    const { error } = await supabase.from('orders').update({ status }).eq('id', order.id)
    setBusy(false)
    if (!error) onChanged?.()
  }

  const isPaid = order.payment_status === 'paid'
  // Once accepted, a supplier can't move an order to packed/out for
  // delivery/delivered until the hotel has paid — payment gates all
  // fulfilment progress past "accepted".
  const paymentGateBlocked = order.status !== 'pending' && !isPaid
  const nextOptions = viewerRole === 'supplier' && !paymentGateBlocked ? STATUS_FLOW[order.status] || [] : []
  const grandTotal = Number(order.grand_total) || Number(order.order_total)

  return (
    <div className="card order-card">
      {onBack && (
        <button type="button" className="btn-link" onClick={onBack} style={{ marginBottom: 10 }}>
          ← Back to orders
        </button>
      )}
      <div className="order-card-header">
        <div>
          <strong>Order #{order.id.slice(0, 8)}</strong>
          <div className="muted small">{new Date(order.created_at).toLocaleString('en-IN')}</div>
        </div>
        <span className={`status-badge status-${order.status}`}>{STATUS_LABEL[order.status]}</span>
      </div>

      <OrderTrackingStepper order={order} delivery={delivery} />

      <div className="order-card-badges">
        <span className={`pay-badge pay-${isPaid ? 'paid' : 'unpaid'}`}>
          {isPaid ? '✓ Paid' : 'Payment pending'}
        </span>
        {order.source === 'whatsapp' && <span className="pay-badge pay-whatsapp">via WhatsApp</span>}
      </div>

      <div className="order-card-meta">
        {order.hotels?.name && <div>Hotel: {order.hotels.name}</div>}
        {order.suppliers?.name && <div>Supplier: {order.suppliers.name} {order.suppliers.apmc_yard ? `(${order.suppliers.apmc_yard})` : ''}</div>}
        {order.delivery_address && <div>Deliver to: {order.delivery_address}</div>}
      </div>

      <table className="table small">
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
        <tbody>
          {order.order_items?.map((it) => {
            // order_items.unit_price is always the supplier's raw price —
            // hotel viewers see it marked up (platform fee folded in, same
            // as at checkout); supplier/admin see the raw number they're
            // actually paid on.
            const rate = viewerRole === 'hotel' ? hotelItemPrice(it.unit_price) : Number(it.unit_price)
            return (
              <tr key={it.id}>
                <td>{it.products?.name}</td>
                <td>{it.quantity} {it.products?.unit}</td>
                <td>₹{rate}</td>
                <td>₹{(it.quantity * rate).toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="order-card-footer">
        {viewerRole === 'supplier' ? (
          // APMC only ever sees their own goods value — Item, Rate, Quantity,
          // Total bill. No delivery charge, no platform fee, no grand total —
          // those are between the hotel and OrderIT, not APMC's concern.
          <div>Total bill: <strong>₹{Number(order.order_total).toFixed(2)}</strong></div>
        ) : (
          <>
            <div>
              <div className="muted small">
                Items subtotal: ₹{(viewerRole === 'hotel' ? hotelItemPrice(order.order_total) : Number(order.order_total)).toFixed(2)}
              </div>
              {viewerRole === 'admin' && (
                <div className="muted small">Platform fee ({order.platform_fee_pct ?? 3}%): ₹{Number(order.platform_fee_amount || 0).toFixed(2)}</div>
              )}
              <div className="muted small">Delivery charge: ₹{Number(order.delivery_charge || 0).toFixed(2)}</div>
              <div>Grand total: <strong>₹{grandTotal.toFixed(2)}</strong></div>
            </div>
            {viewerRole === 'admin' && (
              <div className="muted small">
                Commission ({order.commission_pct}%): ₹{Number(order.commission_amount).toFixed(2)} · Delivery contribution: ₹{Number(order.delivery_contribution).toFixed(2)}
              </div>
            )}
          </>
        )}
      </div>

      <DeliveryPanel
        orderId={order.id}
        viewerRole={viewerRole}
        orderStatus={order.status}
        paymentStatus={order.payment_status}
        orderDeliveryCharge={order.delivery_charge}
        orderDistanceKm={order.delivery_distance_km}
      />

      {paymentGateBlocked && viewerRole === 'supplier' && (
        <div className="alert alert-info">Waiting for payment before this order can move to packed/delivery.</div>
      )}

      <div className="order-card-actions">
        {nextOptions.map((status) => (
          <button
            key={status}
            className={status === 'rejected' ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={busy}
            onClick={() => updateStatus(status)}
          >
            {busy ? '…' : `Mark ${STATUS_LABEL[status]}`}
          </button>
        ))}
        {viewerRole === 'hotel' && !isPaid && !['rejected', 'cancelled'].includes(order.status) && (
          <PaymentButton order={order} onPaid={onChanged} />
        )}
        {order.status === 'delivered' && (
          <button className="btn btn-ghost-dark" onClick={() => downloadInvoice(order)}>Download invoice</button>
        )}
      </div>
    </div>
  )
}
