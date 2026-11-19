const { test } = require('node:test')
const assert = require('node:assert/strict')
const P = require('../pricing.js')
const { calculateQuote, measureRoom, measureExtra, resolvePaint, DEFAULT_RATES, DEFAULT_PRODUCTS, emptyRoom, emptyExtra, describeScope, ROOM_PRESETS, roomFromPreset } = P

const org = { margin_rate: 0.25, gst_rate: 0.1 }

// Pinned rates + products so these tests don't move when the demo defaults are tuned.
const RATES = {
  ...DEFAULT_RATES,
  interior_wall_rate: 5.5, ceiling_rate: 6, trim_rate: 3.5, door_rate: 22, window_rate: 18,
  exterior_wall_rate: 7, exterior_trim_rate: 5, exterior_door_rate: 28, exterior_window_rate: 22,
  min_charge: 350, consumables_pct: 0, round_paint_to_tins: false,
}
const PRODUCTS = [
  { id: 'w', category: 'interior_wall', name: 'Wall paint', pack_size_l: 10, pack_price: 140, coverage_m2_per_l: 12, is_default: true },
  { id: 'c', category: 'ceiling', name: 'Ceiling paint', pack_size_l: 10, pack_price: 100, coverage_m2_per_l: 12, is_default: true },
  { id: 't', category: 'trim', name: 'Trim paint', pack_size_l: 4, pack_price: 100, coverage_m2_per_l: 12, is_default: true },
  { id: 'e', category: 'exterior', name: 'Exterior paint', pack_size_l: 10, pack_price: 180, coverage_m2_per_l: 12, is_default: true },
  { id: 'p', category: 'primer', name: 'Primer', pack_size_l: 10, pack_price: 120, coverage_m2_per_l: 12, is_default: true },
]
const paint = resolvePaint(PRODUCTS)
const calc = (job, over = {}) => calculateQuote({ rates: RATES, organization: org, job, paint, ...over })

const room = { ...emptyRoom('Lounge'), length: 4, width: 3, height: 2.4, doors: 1, windows: 1, ceiling: true, trim: false }

test('measureRoom deducts openings and computes ceiling', () => {
  const m = measureRoom(room)
  assert.equal(m.wallArea, 14 * 2.4 - 1.6 - 1.5) // 30.5
  assert.equal(m.ceilingArea, 12)
  assert.equal(m.trimLength, 0)
})

test('interior room, 2 coats, good condition (hand-calculated)', () => {
  const q = calc({ rooms: [room], coats: 2 })
  // labour: 30.5*5.5*2 = 335.5 ; 12*6*2 = 144  => 479.5 (above the 350 minimum)
  assert.equal(q.labourCost, 479.5)
  // paint: walls 30.5*2*1.1/12 L x $14 = 78.28 ; ceiling 12*2*1.1/12 L x $10 = 22
  assert.equal(q.materialsCost, 100.28)
  assert.equal(q.subtotal, 579.78)
  assert.equal(q.margin, 144.95)
  assert.equal(q.gst, 72.47)
  assert.equal(q.total, 797.2)
})

test('paint cost follows the chosen product (premium vs standard)', () => {
  const premium = [...PRODUCTS, { id: 'w2', category: 'interior_wall', name: 'Premium', pack_size_l: 10, pack_price: 240, coverage_m2_per_l: 12, is_default: false }]
  const a = calc({ rooms: [room], coats: 2 })
  const b = calc({ rooms: [room], coats: 2 }, { paint: resolvePaint(premium, { interior_wall: 'w2' }) })
  assert.ok(b.materialsCost > a.materialsCost)
  assert.equal(b.paintLines.find((l) => l.category === 'interior_wall').label, 'Premium')
  assert.equal(b.labourCost, a.labourCost) // only materials change
})

test('better coverage means fewer litres', () => {
  const thirsty = resolvePaint(PRODUCTS.map((p) => (p.id === 'w' ? { ...p, coverage_m2_per_l: 6 } : p)))
  const a = calc({ rooms: [room] })
  const b = calc({ rooms: [room] }, { paint: thirsty })
  const litres = (q) => q.paintLines.find((l) => l.category === 'interior_wall').litres
  assert.ok(Math.abs(litres(b) - 2 * litres(a)) < 0.2)
})

test('consumables allowance is a % of paint cost', () => {
  const q = calc({ rooms: [room] }, { rates: { ...RATES, consumables_pct: 0.1 } })
  assert.equal(q.paintCost, 100.28)
  assert.equal(q.consumablesCost, 10.03)
  assert.equal(q.materialsCost, 110.31)
})

test('round to whole tins charges full packs', () => {
  const q = calc({ rooms: [room] }, { rates: { ...RATES, round_paint_to_tins: true } })
  const wall = q.paintLines.find((l) => l.category === 'interior_wall')
  assert.equal(wall.packs, 1) // 5.6 L fits in one 10 L tin
  assert.equal(wall.cost, 140)
})

test('minimum charge applies to small jobs', () => {
  const tiny = { ...emptyRoom('Closet'), length: 1, width: 1, height: 2.4, doors: 0, windows: 0, ceiling: false, trim: false }
  const q = calc({ rooms: [tiny], coats: 1 })
  assert.equal(q.labourCost, RATES.min_charge)
})

test('empty job costs nothing (no phantom minimum charge)', () => {
  assert.equal(calc({ rooms: [] }).total, 0)
})

test('other surfaces: a feature wall is priced like wall area', () => {
  const feature = { ...emptyExtra('wall'), label: 'Feature wall', a: 3.5, b: 2.4 }
  assert.equal(measureExtra(feature).area, 8.4)
  const q = calc({ extras: [feature], coats: 2 })
  // 8.4 * 5.5 * 2 = 92.4 -> below minimum charge, so labour = 350
  assert.equal(q.quantities.interior.wallArea, 8.4)
  assert.equal(q.labourCost, 350)
  // and it adds on top of a room
  const withRoom = calc({ rooms: [room], extras: [feature], coats: 2 })
  const roomOnly = calc({ rooms: [room], coats: 2 })
  assert.ok(Math.abs(withRoom.labourCost - roomOnly.labourCost - 92.4) < 0.01)
})

test('other surfaces: exterior kinds use exterior rates and storey factor', () => {
  const fence = { ...emptyExtra('ext_wall'), label: 'Fence', a: 20, b: 1.8 }
  const q = calc({ extras: [fence], exterior: { wallArea: 0, storeys: 2 }, coats: 2 })
  // 36 m2 * 7 * 2 * 1.25 = 630
  assert.equal(q.labourCost, 630)
})

test('condition factor and storey factor scale labour', () => {
  const job = { exterior: { wallArea: 100, trimLength: 0, doors: 0, windows: 0, storeys: 2 }, coats: 2, condition: 'fair' }
  assert.equal(calc(job).labourCost, 2012.5) // 100*7*2*1.25 = 1750 x 1.15
})

test('primer adds labour and paint', () => {
  const a = calc({ rooms: [room], coats: 2 })
  const b = calc({ rooms: [room], coats: 2, primer: true })
  assert.ok(b.labourCost > a.labourCost)
  assert.ok(b.materialsCost > a.materialsCost)
  assert.ok(b.paintLines.some((p) => p.category === 'primer'))
})

test('equipment lines are added before margin', () => {
  const q = calc({ rooms: [room], coats: 2, equipment: [{ name: 'Scaffold hire', cost: 200 }, { name: 'blank', cost: 0 }] })
  assert.equal(q.equipmentCost, 200)
  assert.equal(q.subtotal, 779.78)
})

test('customer scope never contains money and lists rooms and extras', () => {
  const feature = { ...emptyExtra('wall'), label: 'Feature wall', a: 3.5, b: 2.4 }
  const job = { rooms: [room], extras: [feature], coats: 2 }
  const q = calc(job)
  const text = describeScope({ job, quantities: q.quantities }).join(' ')
  assert.ok(!text.includes('$'))
  assert.ok(text.includes('Lounge'))
  assert.ok(text.includes('Feature wall'))
})

test('labour line amounts sum to labour cost', () => {
  const q = calc({ rooms: [{ ...room, trim: true }], coats: 2, condition: 'poor' })
  const sum = q.labourLines.reduce((t, l) => t + l.amount, 0)
  assert.ok(Math.abs(sum - q.labourCost) < 0.05)
})

test('resolvePaint falls back to defaults when the catalogue is empty', () => {
  const p = resolvePaint([])
  assert.equal(Object.keys(p).length, 5)
  assert.ok(p.interior_wall.pack_price > 0)
})

test('room presets build valid, flagged-as-estimate rooms', () => {
  const bed = roomFromPreset(ROOM_PRESETS.find((p) => p.id === 'bed'), 2.7)
  assert.equal(bed.source, 'estimate')
  assert.equal(bed.height, 2.7)
  assert.ok(measureRoom(bed).wallArea > 0)
})

// Sanity check that the shipped demo defaults land in the researched Australian ballparks
// (3-bed interior repaint ~ $3k-$9k incl. GST; single-storey exterior ~ $5k-$12k).
test('demo defaults land in ballpark ranges', () => {
  const dflt = (job) => calculateQuote({
    rates: DEFAULT_RATES, organization: org, job,
    paint: resolvePaint(DEFAULT_PRODUCTS.map((p, i) => ({ ...p, id: String(i) }))),
  })
  const r = (id, h = 2.4, over = {}) => roomFromPreset(ROOM_PRESETS.find((p) => p.id === id), h) && { ...roomFromPreset(ROOM_PRESETS.find((p) => p.id === id), h), ...over }
  const threeBed = ['master', 'bed', 'bed', 'bath', 'living', 'kitchen', 'hall', 'laundry', 'toilet'].map((id) => r(id))
  const interior = dflt({ rooms: threeBed, coats: 2 })
  assert.ok(interior.total > 3000 && interior.total < 9000, `3-bed interior was ${interior.total}`)

  const single = dflt({ rooms: [r('bed')], coats: 2 })
  assert.ok(single.total >= 300 && single.total <= 1000, `single room was ${single.total}`)

  const exteriorJob = dflt({ exterior: { wallArea: 110, otherArea: 0, trimLength: 45, doors: 2, windows: 8, storeys: 1 }, coats: 2 })
  assert.ok(exteriorJob.total > 4500 && exteriorJob.total < 12000, `exterior was ${exteriorJob.total}`)
})

// ---- services ----
const base = () => ({ rates: DEFAULT_RATES, organization: org, paint: resolvePaint(DEFAULT_PRODUCTS.map((p, i) => ({ ...p, id: 'p' + i }))) })

test('disabled built-in service is left out of the quote', () => {
  const job = { rooms: [roomFromPreset(ROOM_PRESETS.find((p) => p.id === 'bed'))], coats: 2 }
  const all = calculateQuote({ ...base(), job })
  const noCeil = calculateQuote({ ...base(), job, enabled: { ceiling: false } })
  assert.ok(noCeil.total < all.total)
  assert.equal(noCeil.quantities.interior.ceilingArea, 0)
})

test('custom services: per-sqm painted service adds labour and paint', () => {
  const services = P.defaultServices().map((s) => (s.id === 'fence' ? { ...s, enabled: true } : s))
  const q = calculateQuote({ ...base(), services, job: { custom: [{ service_id: 'fence', qty: 30 }], coats: 2 } })
  assert.equal(q.customLines[0].amount, 30 * 14 * 2)
  assert.ok(q.paintCost > 0)
  assert.ok(q.total > 0)
  assert.ok(describeScope({ job: {}, quantities: q.quantities }).some((l) => l.includes('Fences: 30 sqm')))
})

test('custom services: hourly, fixed, minimum charge, not per coat', () => {
  const services = P.defaultServices().map((s) => ['plaster', 'pressure_wash'].includes(s.id) ? { ...s, enabled: true } : s)
  const q = calculateQuote({ ...base(), services, job: { custom: [{ service_id: 'plaster', qty: 3 }, { service_id: 'pressure_wash', qty: 10 }], coats: 3 } })
  assert.equal(q.customLines[0].amount, 225) // 3h x $75, coats ignored
  assert.equal(q.customLines[1].amount, 150) // 10sqm x $4 = $40 -> min $150
  assert.equal(q.paintCost, 0)
})

test('services that are switched off are ignored', () => {
  const q = calculateQuote({ ...base(), services: P.defaultServices(), job: { custom: [{ service_id: 'fence', qty: 30 }] } })
  assert.equal(q.total, 0)
})

// ---- Queensland / older timber homes ----
test('older timber home costs more (labour + paint) and says so on the scope', () => {
  const q3 = P.HOUSE_TEMPLATES.find((t) => t.id === 'queenslander')
  const rooms = P.roomsFromTemplate(q3)
  const plain = calculateQuote({ ...base(), job: { rooms, coats: 2 } })
  const old = calculateQuote({ ...base(), job: { rooms, coats: 2, heritage: true } })
  assert.ok(old.labourCost > plain.labourCost * 1.25)
  assert.ok(old.paintCost > plain.paintCost * 1.1)
  assert.ok(describeScope({ job: { rooms }, quantities: old.quantities }).some((l) => l.includes('timber')))
})
test('house templates: names numbered, heights applied, all estimates', () => {
  P.HOUSE_TEMPLATES.forEach((t) => {
    const rooms = P.roomsFromTemplate(t)
    assert.equal(rooms.length, t.rooms.length)
    assert.ok(rooms.every((r) => r.source === 'estimate' && r.height === t.height))
  })
  const names = P.roomsFromTemplate(P.HOUSE_TEMPLATES[0]).map((r) => r.name)
  assert.ok(names.includes('Bedroom 1') && names.includes('Bedroom 2') && names.includes('Master bedroom'))
})
test('Queenslander ballpark: 3-bed interior with high ceilings lands in a sane range', () => {
  const rooms = P.roomsFromTemplate(P.HOUSE_TEMPLATES.find((t) => t.id === 'queenslander'))
  const q = calculateQuote({ ...base(), job: { rooms, coats: 2, heritage: true } })
  assert.ok(q.total > 7000 && q.total < 17000, 'total ' + q.total) // published Brisbane guides: ~9.5-16.5k for a 4BR interior
})
