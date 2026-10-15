import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../supabaseClient'
import SupplierOrderTable from '../components/SupplierOrderTable'
import SupplierRevenueReport from '../components/SupplierRevenueReport'
import OpenRequests from '../components/OpenRequests'
import { downloadSupplierPriceTemplate, parseSupplierPriceTemplate } from '../lib/excelTemplates'

export default function SupplierDashboard({ supplier }) {
  const [tab, setTab] = useState('orders')
  const [products, setProducts] = useState([])
  const [myPrices, setMyPrices] = useState({}) // keyed by product_id
  const [orders, setOrders] = useState([])
  const [saving, setSaving] = useState('')
  const [bulkMessage, setBulkMessage] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const fileInputRef = useRef(null)

  const loadProducts = useCallback(async () => {
    const { data } = await supabase.from('products').select('*').eq('active', true).order('name')
    setProducts(data || [])
  }, [])

  const loadMyPrices = useCallback(async () => {
    if (!supplier?.id) return
    const { data } = await supabase
      .from('supplier_prices')
      .select('*')
      .eq('supplier_id', supplier.id)
      .eq('price_date', new Date().toISOString().slice(0, 10))
    const map = {}
    for (const row of data || []) map[row.product_id] = row
    setMyPrices(map)
  }, [supplier])

  const loadOrders = useCallback(async () => {
    if (!supplier?.id) return
    const { data } = await supabase
      .from('orders')
      .select('*, order_items(*, products(*)), hotels(name, address, phone, email), suppliers(name, apmc_yard), deliveries(*)')
      .eq('supplier_id', supplier.id)
      .order('created_at', { ascending: false })
    setOrders(data || [])
  }, [supplier])

  useEffect(() => { loadProducts() }, [loadProducts])
  useEffect(() => { loadMyPrices() }, [loadMyPrices])
  useEffect(() => { loadOrders() }, [loadOrders])

  useEffect(() => {
    if (!supplier?.id) return
    const channel = supabase
      .channel(`supplier-orders-${supplier.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `supplier_id=eq.${supplier.id}` },
        () => loadOrders()
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [supplier, loadOrders])

  const savePrice = async (productId, price, grade, availableQty, inStock, lowStockThreshold) => {
    if (!price || price <= 0) return
    setSaving(productId)
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabase
      .from('supplier_prices')
      .upsert(
        {
          supplier_id: supplier.id,
          product_id: productId,
          price,
          grade,
          available_qty: availableQty || 0,
          in_stock: inStock,
          low_stock_threshold: lowStockThreshold || 5,
          price_date: today
        },
        { onConflict: 'supplier_id,product_id,price_date' }
      )
    setSaving('')
    if (!error) loadMyPrices()
  }

  const handleDownloadTemplate = () => {
    downloadSupplierPriceTemplate(products, myPrices, supplier?.name)
  }

  const handleUploadTemplate = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkBusy(true)
    setBulkMessage('')
    try {
      const { rows, unmatched } = await parseSupplierPriceTemplate(file, products)
      if (!rows.length) {
        setBulkMessage('No valid priced rows found in the file. Make sure the Price column is filled in.')
        setBulkBusy(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
      const today = new Date().toISOString().slice(0, 10)
      const payload = rows.map((r) => ({ ...r, supplier_id: supplier.id, price_date: today }))
      const { error } = await supabase
        .from('supplier_prices')
        .upsert(payload, { onConflict: 'supplier_id,product_id,price_date' })

      if (error) {
        setBulkMessage(`Upload failed: ${error.message}`)
      } else {
        let msg = `Updated ${rows.length} price${rows.length === 1 ? '' : 's'}.`
        if (unmatched.length) msg += ` ${unmatched.length} row(s) didn't match a catalogue product: ${unmatched.join(', ')}.`
        setBulkMessage(msg)
        loadMyPrices()
      }
    } catch (err) {
      setBulkMessage(`Couldn't read that file: ${err.message}`)
    }
    setBulkBusy(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div>
      <h2>{supplier?.name}</h2>
      <div className="tabs">
        <button className={tab === 'orders' ? 'tab active' : 'tab'} onClick={() => setTab('orders')}>Incoming orders ({orders.length})</button>
        <button className={tab === 'prices' ? 'tab active' : 'tab'} onClick={() => setTab('prices')}>Today's prices</button>
        <button className={tab === 'bidding' ? 'tab active' : 'tab'} onClick={() => setTab('bidding')}>Open requests</button>
        <button className={tab === 'reports' ? 'tab active' : 'tab'} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'orders' && <SupplierOrderTable orders={orders} onChanged={loadOrders} />}

      {tab === 'reports' && <SupplierRevenueReport orders={orders} />}

      {tab === 'bidding' && <OpenRequests supplier={supplier} />}

      {tab === 'prices' && (
        <div className="card">
          <p className="muted">Set today's price, grade, stock status and available quantity per product. Hotels see these instantly.</p>

          <div className="bulk-bar">
            <button className="btn btn-ghost-dark" onClick={handleDownloadTemplate}>⬇ Download price template (.xlsx)</button>
            <label className="btn btn-ghost-dark upload-label">
              {bulkBusy ? 'Uploading…' : '⬆ Upload filled template'}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleUploadTemplate}
                disabled={bulkBusy}
                hidden
              />
            </label>
          </div>
          {bulkMessage && <div className="alert alert-info">{bulkMessage}</div>}

          <table className="table">
            <thead>
              <tr><th>Product</th><th>Price (₹)</th><th>Grade</th><th>Stock</th><th>Available qty</th><th>Low-stock alert at</th><th></th></tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const existing = myPrices[p.id]
                return (
                  <PriceRow
                    key={p.id}
                    product={p}
                    existing={existing}
                    saving={saving === p.id}
                    onSave={savePrice}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PriceRow({ product, existing, saving, onSave }) {
  const [price, setPrice] = useState(existing?.price ?? '')
  const [grade, setGrade] = useState(existing?.grade ?? 'A')
  const [qty, setQty] = useState(existing?.available_qty ?? '')
  const [inStock, setInStock] = useState(existing?.in_stock ?? true)
  const [threshold, setThreshold] = useState(existing?.low_stock_threshold ?? 5)

  useEffect(() => {
    setPrice(existing?.price ?? '')
    setGrade(existing?.grade ?? 'A')
    setQty(existing?.available_qty ?? '')
    setInStock(existing?.in_stock ?? true)
    setThreshold(existing?.low_stock_threshold ?? 5)
  }, [existing])

  const isLowStock = inStock && qty !== '' && Number(qty) > 0 && Number(qty) <= Number(threshold || 5)

  return (
    <tr>
      <td>{product.name} <span className="muted small">/ {product.unit}</span></td>
      <td><input type="number" min="0" step="0.5" className="qty-input" value={price} onChange={(e) => setPrice(e.target.value)} /></td>
      <td>
        <select value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="A">A</option>
          <option value="B">B</option>
        </select>
      </td>
      <td>
        <button
          type="button"
          className={`stock-toggle ${inStock ? 'in-stock' : 'out-of-stock'}`}
          onClick={() => setInStock((v) => !v)}
        >
          {inStock ? 'In stock' : 'Out of stock'}
        </button>
        {isLowStock && <div className="delivery-badge delivery-requested" style={{ marginTop: 4 }}>Low stock</div>}
      </td>
      <td><input type="number" min="0" className="qty-input" value={qty} onChange={(e) => setQty(e.target.value)} /></td>
      <td><input type="number" min="0" className="qty-input" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></td>
      <td>
        <button className="btn btn-primary" disabled={saving} onClick={() => onSave(product.id, parseFloat(price), grade, parseFloat(qty), inStock, parseFloat(threshold))}>
          {saving ? 'Saving…' : existing ? 'Update' : 'Publish'}
        </button>
      </td>
    </tr>
  )
}
