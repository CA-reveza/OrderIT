import { useState, Fragment } from 'react'
import OrderCard from './OrderCard'
import { getDeliveryStatus } from '../lib/deliveryStatus'

const STATUS_LABEL = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  packed: 'Packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
}

function orderDelivery(order) {
  return Array.isArray(order.deliveries) ? order.deliveries[0] : order.deliveries
}

// Compact incoming-orders list for suppliers: just enough to triage at a
// glance (who, how to reach them, how much, what stage). Clicking the order
// number expands the full OrderCard (items, delivery panel, status actions)
// in place, right below that row.
export default function SupplierOrderTable({ orders, onChanged }) {
  const [expandedId, setExpandedId] = useState(null)

  if (!orders.length) return <p className="muted">No orders yet.</p>

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>Hotel</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Order</th>
            <th>Rate × Qty total</th>
            <th>Status</th>
            <th>Delivery</th>
            <th>Payment</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const isExpanded = expandedId === order.id
            const deliveryStatus = getDeliveryStatus(orderDelivery(order))
            return (
              <Fragment key={order.id}>
                <tr>
                  <td>{order.hotels?.name || '—'}</td>
                  <td>{order.hotels?.phone || '—'}</td>
                  <td>{order.hotels?.email || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => setExpandedId(isExpanded ? null : order.id)}
                    >
                      #{order.id.slice(0, 8)} {isExpanded ? '▲' : '▼'}
                    </button>
                  </td>
                  <td>₹{Number(order.order_total).toFixed(2)}</td>
                  <td><span className={`status-badge status-${order.status}`}>{STATUS_LABEL[order.status]}</span></td>
                  <td><span className={`delivery-badge delivery-${deliveryStatus.className}`}>{deliveryStatus.label}</span></td>
                  <td>
                    <span className={`pay-badge pay-${order.payment_status === 'paid' ? 'paid' : 'unpaid'}`}>
                      {order.payment_status === 'paid' ? '✓ Paid' : 'Unpaid'}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={8} className="order-detail-cell">
                      <OrderCard order={order} viewerRole="supplier" onChanged={onChanged} onBack={() => setExpandedId(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
