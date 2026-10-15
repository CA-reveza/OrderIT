import { useEffect, useState, useCallback, Fragment } from 'react'
import { supabase } from '../supabaseClient'
import { BASE_DELIVERY_KM, totalDeliveryCharge, hotelItemPrice, vehicleForWeight, productUnitWeightKg, VEHICLE_TIERS } from '../lib/orderFees'

export default function QuoteRequests({ hotel, products, onOrderPlaced }) {
  const [requests, setRequests] = useState([])
  const [selected, setSelected] = useState({}) // product_id -> qty (only present if checked)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [expandedQuote, setExpandedQuote] = useState(null) // quote id showing itemized breakdown

  const load = useCallback(async () => {
    if (!hotel?.id) return
    const { data } = await supabase
      .from('quote_requests')
      .select(`
        *,
        quote_request_items(*, products(*)),
        supplier_quotes(*, suppliers(name, apmc_yard), supplier_quote_items(*, products(*)))
      `)
      .eq('hotel_id', hotel.id)
      .order('created_at', { ascending: false })
    setRequests(data || [])
  }, [hotel])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!hotel?.id) return
    const channel = supabase
      .channel(`hotel-quotes-${hotel.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplier_quotes' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplier_quote_items' }, () => load())
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [hotel, load])

  const toggleItem = (productId, checked) => {
    setSelected((prev) => {
      const next = { ...prev }
      if (checked) next[productId] = next[productId] || 1
      else delete next[productId]
      return next
    })
  }

  const setItemQty = (productId, qty) => {
    setSelected((prev) => ({ ...prev, [productId]: qty }))
  }

  const selectedCount = Object.keys(selected).length

  const createRequest = async (e) => {
    e.preventDefault()
    const items = Object.entries(selected).filter(([, qty]) => qty > 0)
    if (!items.length) {
      setMessage('Tick at least one item and enter a quantity before posting.')
      return
    }
    setBusy(true)
    setMessage('')

    const { data: request, error: reqErr } = await supabase
      .from('quote_requests')
      .insert({ hotel_id: hotel.id, notes })
      .select()
      .single()

    if (reqErr) {
      setMessage(`Failed to post request: ${reqErr.message}`)
      setBusy(false)
      return
    }

    const itemRows = items.map(([product_id, qty]) => ({
      request_id: request.id,
      product_id,
      quantity: parseFloat(qty)
    }))
    const { error: itemsErr } = await supabase.from('quote_request_items').insert(itemRows)

    setBusy(false)
    if (itemsErr) {
      setMessage(`Request created but items failed: ${itemsErr.message}`)
    } else {
      setMessage(`Posted a request for ${items.length} item${items.length === 1 ? '' : 's'} to every supplier.`)
      setSelected({})
      setNotes('')
      load()
    }
  }

  const acceptQuote = async (request, quote) => {
    setMessage('')
    // Quote acceptance has no distance input, so it's priced at the 5km base.
    // Weight is worked out automatically from the requested items; over 20kg
    // means the 3-Wheeler rate applies instead of the 2-Wheeler one.
    const weightKg = (request.quote_request_items || []).reduce(
      (sum, qi) => sum + Number(qi.quantity || 0) * productUnitWeightKg(qi.products), 0)
    const vehicle = vehicleForWeight(weightKg)
    const deliveryTotal = totalDeliveryCharge(BASE_DELIVERY_KM, vehicle)
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        hotel_id: hotel.id,
        supplier_id: quote.supplier_id,
        delivery_address: hotel.address,
        delivery_distance_km: BASE_DELIVERY_KM,
        delivery_charge: deliveryTotal,
        delivery_vehicle_type: vehicle
      })
      .select()
      .single()
    if (orderErr) { setMessage(`Failed: ${orderErr.message}`); return }

    const items = (quote.supplier_quote_items || []).map((sqi) => {
      const reqItem = request.quote_request_items?.find((qi) => qi.product_id === sqi.product_id)
      return {
        order_id: order.id,
        product_id: sqi.product_id,
        quantity: reqItem?.quantity || 0,
        unit_price: sqi.price // raw supplier price — stays what APMC gets paid on
      }
    })
    await supabase.from('order_items').insert(items)
    await supabase.from('quote_requests').update({ status: 'closed' }).eq('id', request.id)

    const tier = VEHICLE_TIERS[vehicle]
    const grandTotal = hotelItemPrice(quote.total_price) + deliveryTotal
    setMessage(`Order placed with ${quote.suppliers?.name} — items ₹${hotelItemPrice(quote.total_price).toFixed(2)}, grand total ≈₹${grandTotal.toFixed(2)}. Delivery is priced for a ${tier.label} (${weightKg.toFixed(1)} kg) at ${BASE_DELIVERY_KM} km: ₹${tier.baseCharge} up to ${BASE_DELIVERY_KM} km, then +₹${tier.perKmAfter}/km beyond that.`)
    load()
    onOrderPlaced?.()
  }

  return (
    <div>
      <div className="card">
        <h3>Request quotes from suppliers</h3>
        <p className="muted small">Tick the items you need, set quantities, and broadcast the requirement to every registered supplier for comparison.</p>

        <table className="table small">
          <thead><tr><th></th><th>Product</th><th>Qty</th></tr></thead>
          <tbody>
            {products.map((p) => {
              const checked = selected[p.id] !== undefined
              return (
                <tr key={p.id}>
                  <td>
                    <input type="checkbox" checked={checked} onChange={(e) => toggleItem(p.id, e.target.checked)} />
                  </td>
                  <td>{p.name} <span className="muted small">/ {p.unit}</span></td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      className="qty-input"
                      disabled={!checked}
                      value={checked ? selected[p.id] : ''}
                      onChange={(e) => setItemQty(p.id, parseFloat(e.target.value) || 0)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <div className="form-row" style={{ marginTop: 12 }}>
          <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !selectedCount} onClick={createRequest}>
            {busy ? 'Posting…' : `Post request${selectedCount ? ` (${selectedCount} item${selectedCount === 1 ? '' : 's'})` : ''}`}
          </button>
        </div>
        {message && <div className="alert alert-info">{message}</div>}
      </div>

      {requests.map((r) => (
        <div key={r.id} className="card">
          <div className="order-card-header">
            <div>
              <strong>{r.quote_request_items?.length || 0} item{(r.quote_request_items?.length || 0) === 1 ? '' : 's'} requested</strong>
              <div className="muted small">
                {r.quote_request_items?.map((qi) => `${qi.products?.name} × ${qi.quantity} ${qi.products?.unit}`).join(', ')}
              </div>
              {r.notes && <div className="muted small">Note: {r.notes}</div>}
            </div>
            <span className={`status-badge status-${r.status === 'open' ? 'pending' : 'delivered'}`}>{r.status}</span>
          </div>

          {!r.supplier_quotes?.length && <p className="muted small">No quotes yet.</p>}
          {r.supplier_quotes?.length > 0 && (
            <table className="table small">
              <thead><tr><th>Supplier</th><th>Total</th><th></th><th></th></tr></thead>
              <tbody>
                {[...r.supplier_quotes].sort((a, b) => a.total_price - b.total_price).map((q) => (
                  <Fragment key={q.id}>
                    <tr>
                      <td>{q.suppliers?.name} {q.suppliers?.apmc_yard ? `(${q.suppliers.apmc_yard})` : ''}</td>
                      <td>₹{hotelItemPrice(q.total_price).toFixed(2)}</td>
                      <td>
                        <button className="btn-link" onClick={() => setExpandedQuote(expandedQuote === q.id ? null : q.id)}>
                          {expandedQuote === q.id ? 'Hide items' : 'View items'}
                        </button>
                      </td>
                      <td>
                        {r.status === 'open' && (
                          <button className="btn btn-primary" onClick={() => acceptQuote(r, q)}>Accept & order</button>
                        )}
                      </td>
                    </tr>
                    {expandedQuote === q.id && (
                      <tr>
                        <td colSpan={4}>
                          <table className="table small">
                            <thead><tr><th>Product</th><th>Price</th><th>Grade</th><th>Available</th></tr></thead>
                            <tbody>
                              {q.supplier_quote_items?.map((sqi) => (
                                <tr key={sqi.id}>
                                  <td>{sqi.products?.name}</td>
                                  <td>₹{hotelItemPrice(sqi.price)}</td>
                                  <td>{sqi.grade}</td>
                                  <td>{sqi.available_qty ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  )
}
