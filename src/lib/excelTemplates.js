import * as XLSX from 'xlsx'
import { hotelItemPrice } from './orderFees'

// ----------------------------------------------------------------------------
// SUPPLIER SIDE — download a price-list template pre-filled with today's
// values (blank where not yet set), fill it in Excel, upload it back to
// bulk-upsert supplier_prices in one go.
// ----------------------------------------------------------------------------

const SUPPLIER_HEADERS = ['Product', 'Unit', 'Price (Rs)', 'Grade (A/B)', 'In Stock (Yes/No)', 'Available Qty', 'Low Stock Alert At']

export function downloadSupplierPriceTemplate(products, myPrices, supplierName) {
  const rows = products.map((p) => {
    const existing = myPrices[p.id]
    return {
      [SUPPLIER_HEADERS[0]]: p.name,
      [SUPPLIER_HEADERS[1]]: p.unit,
      [SUPPLIER_HEADERS[2]]: existing?.price ?? '',
      [SUPPLIER_HEADERS[3]]: existing?.grade ?? 'A',
      [SUPPLIER_HEADERS[4]]: existing ? (existing.in_stock === false ? 'No' : 'Yes') : 'Yes',
      [SUPPLIER_HEADERS[5]]: existing?.available_qty ?? '',
      [SUPPLIER_HEADERS[6]]: existing?.low_stock_threshold ?? 5
    }
  })
  const sheet = XLSX.utils.json_to_sheet(rows, { header: SUPPLIER_HEADERS })
  sheet['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 16 }]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Prices')
  const fileName = `price-list-${(supplierName || 'supplier').replace(/\s+/g, '-').toLowerCase()}.xlsx`
  XLSX.writeFile(workbook, fileName)
}

// Parses an uploaded price-list workbook. Matches rows to products by exact
// (case-insensitive) name. Returns { rows, unmatched } where `rows` are ready
// to upsert into supplier_prices and `unmatched` lists any product names in
// the sheet that didn't match the catalogue (e.g. typos, renamed product).
export async function parseSupplierPriceTemplate(file, products) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  const byName = new Map(products.map((p) => [p.name.trim().toLowerCase(), p]))
  const rows = []
  const unmatched = []

  for (const row of json) {
    const name = String(row[SUPPLIER_HEADERS[0]] ?? '').trim()
    if (!name) continue
    const product = byName.get(name.toLowerCase())
    if (!product) {
      unmatched.push(name)
      continue
    }
    const price = parseFloat(row[SUPPLIER_HEADERS[2]])
    if (!price || price <= 0) continue // skip rows left blank

    const gradeRaw = String(row[SUPPLIER_HEADERS[3]] ?? 'A').trim().toUpperCase()
    const grade = gradeRaw === 'B' ? 'B' : 'A'
    const inStockRaw = String(row[SUPPLIER_HEADERS[4]] ?? 'Yes').trim().toLowerCase()
    const inStock = !(inStockRaw === 'no' || inStockRaw === 'n' || inStockRaw === 'false' || inStockRaw === '0')
    const qty = parseFloat(row[SUPPLIER_HEADERS[5]]) || 0
    const lowStockThreshold = parseFloat(row[SUPPLIER_HEADERS[6]]) || 5

    rows.push({ product_id: product.id, price, grade, in_stock: inStock, available_qty: qty, low_stock_threshold: lowStockThreshold })
  }

  return { rows, unmatched }
}

// ----------------------------------------------------------------------------
// HOTEL SIDE — download a blank-quantity order sheet for a chosen supplier's
// current price list, fill in the Qty column, upload it back to bulk-fill
// the cart instead of typing quantities into the on-screen grid.
// ----------------------------------------------------------------------------

const HOTEL_HEADERS = ['Product', 'Unit', 'Price (Rs)', 'In Stock', 'Qty']

export function downloadHotelOrderTemplate(priceRows, supplierName) {
  const rows = priceRows.map((row) => ({
    [HOTEL_HEADERS[0]]: row.products?.name,
    [HOTEL_HEADERS[1]]: row.products?.unit,
    [HOTEL_HEADERS[2]]: hotelItemPrice(row.price), // hotel-facing price, platform fee already included
    [HOTEL_HEADERS[3]]: row.in_stock === false ? 'Out of stock' : 'In stock',
    [HOTEL_HEADERS[4]]: ''
  }))
  const sheet = XLSX.utils.json_to_sheet(rows, { header: HOTEL_HEADERS })
  sheet['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Order')
  const fileName = `order-sheet-${(supplierName || 'supplier').replace(/\s+/g, '-').toLowerCase()}.xlsx`
  XLSX.writeFile(workbook, fileName)
}

// Parses an uploaded order sheet against the currently-loaded price rows for
// the selected supplier. Returns { cart, skippedOutOfStock, unmatched }.
export async function parseHotelOrderTemplate(file, priceRows) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  const byName = new Map(priceRows.map((r) => [r.products?.name?.trim().toLowerCase(), r]))
  const cart = {}
  const skippedOutOfStock = []
  const unmatched = []

  for (const row of json) {
    const name = String(row[HOTEL_HEADERS[0]] ?? '').trim()
    if (!name) continue
    const qty = parseFloat(row[HOTEL_HEADERS[4]])
    if (!qty || qty <= 0) continue

    const priceRow = byName.get(name.toLowerCase())
    if (!priceRow) {
      unmatched.push(name)
      continue
    }
    if (priceRow.in_stock === false) {
      skippedOutOfStock.push(name)
      continue
    }
    cart[priceRow.product_id] = qty
  }

  return { cart, skippedOutOfStock, unmatched }
}
