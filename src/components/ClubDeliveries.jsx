import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'

// Lets a supplier/APMC pick 2+ of their own paid+packed orders (that don't
// already have a delivery booked) and book ONE shared MoveIT trip covering
// all of them, instead of booking each separately. Each hotel's own order
// keeps whatever delivery_charge it was already given at checkout, and the
// combined fare is just the sum of those — clubbing changes how many trips
// APMC makes, not what any order was charged. Vehicle assignment (2W vs 3W)
// is MOTOR admin's call, same as a single-order "Book via MoveIT" — this
// only asks for the trip distance.
export default function ClubDeliveries({ supplier }) {
  const [eligible, setEligible] = useState([])
  const [selected, setSelected] = useState({}) // order_id -> true
  const [distanceKm, setDistanceKm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    if (!supplier?.id) return
    const { data } = await supabase
      .from('orders')
      .select('id, hotel_id, delivery_address, delivery_charge, created_at, hotels(name, address), deliveries(id)')
      .eq('supplier_id', supplier.id)
      .eq('payment_status', 'paid')
      .in('status', ['packed', 'out_for_delivery'])
      .order('created_at', { ascending: true })
    // Only orders with no delivery booked yet are eligible to club.
    setEligible((data || []).filter((o) => !o.deliveries?.length && !(Array.isArray(o.deliveries) ? o.deliveries[0] : o.deliveries)))
  }, [supplier])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!supplier?.id) return
    const channel = supabase
      .channel(`club-deliveries-${supplier.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `supplier_id=eq.${supplier.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => load())
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [supplier, load])

  const toggle = (orderId) => setSelected((prev) => ({ ...prev, [orderId]: !prev[orderId] }))
  const selectedIds = Object.keys(selected).filter((id) => selected[id])
  const selectedOrders = eligible.filter((o) => selectedIds.includes(o.id))
  const combinedFare = selectedOrders.reduce((sum, o) => sum + (Number(o.delivery_charge) || 0), 0)

  const bookClubbed = async () => {
    const km = parseFloat(distanceKm)
    if (selectedIds.length < 2 || !km) return
    setBusy(true)
    setMessage('')
    const { data, error } = await supabase.functions.invoke('book-motor-delivery', {
      body: { order_ids: selectedIds, distance_km: km }
    })
    setBusy(false)
    if (error) {
      setMessage(`Failed to book: ${error.message || 'check that the Edge Function is deployed'}`)
    } else {
      setMessage(`Booked! ${data?.orders_clubbed ?? selectedIds.length} orders combined into one MoveIT trip, ₹${data?.fare_estimate} total. MoveIT admin will assign the vehicle.`)
      setSelected({})
      setDistanceKm('')
      load()
    }
  }

  if (!eligible.length) return null

  return (
    <div className="card">
      <h3>Club deliveries</h3>
      <p className="muted small">
        Pick 2 or more paid, packed orders heading out together and book them as one MoveIT trip instead of separately. Rates are the same as usual — just billed once for the whole trip. MoveIT's admin decides 2-Wheeler vs 3-Wheeler.
      </p>

      <table className="table small">
        <thead><tr><th></th><th>Hotel</th><th>Order</th><th>Packed on</th></tr></thead>
        <tbody>
          {eligible.map((o) => (
            <tr key={o.id}>
              <td><input type="checkbox" checked={!!selected[o.id]} onChange={() => toggle(o.id)} /></td>
              <td>{o.hotels?.name || '—'}</td>
              <td>#{o.id.slice(0, 8)}</td>
              <td>{new Date(o.created_at).toLocaleDateString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selectedIds.length > 0 && (
        <div className="delivery-form" style={{ marginTop: 10 }}>
          <div className="muted small">{selectedIds.length} order{selectedIds.length === 1 ? '' : 's'} selected: {selectedOrders.map((o) => o.hotels?.name || `#${o.id.slice(0, 8)}`).join(', ')}</div>
          {selectedIds.length === 1 && <div className="alert alert-info">Pick at least one more order to club, or book it normally from that order's own delivery panel.</div>}

          <input
            type="number" min="0" step="0.5" placeholder="Trip distance (km)"
            value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)}
          />
          <div className="muted small">Trip fare: ₹{combinedFare.toFixed(2)} total (sum of the selected orders' own delivery charges).</div>
          {message && <div className="alert alert-info">{message}</div>}
          <div className="delivery-form-actions">
            <button className="btn btn-primary" disabled={busy || selectedIds.length < 2 || !distanceKm} onClick={bookClubbed}>
              {busy ? 'Booking…' : 'Book via MoveIT'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
