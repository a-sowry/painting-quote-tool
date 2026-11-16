// PaintQuote pricing engine - plain script (no build step). Works in the browser as window.PQ
// and in Node (require) for the tests. See README for how the numbers work.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PQ = factory()
})(typeof self !== 'undefined' ? self : this, function () {
'use strict'
// Pure pricing engine for painting quotes. No UI or database code in here.
//
//   Labour    = surface area (or count) x labour rate x coats, for each surface type
//               x condition factor (surface prep) x storey factor (exterior only)
//               + a primer pass on walls/ceilings if requested
//               never below the company's minimum charge
//   Materials = litres of paint needed (area x coats x wastage / coverage), priced from the
//               company's own paint catalogue (pack size + pack price), plus a consumables
//               allowance (masking tape, drop sheets, filler, sandpaper) as a % of paint cost
//   Equipment = itemised lines added on each quote (scaffold hire, subcontractors...)
// Margin and GST are then applied to the subtotal.
//
// Every rate and paint product is per company and editable. DEFAULT_RATES / DEFAULT_PRODUCTS
// are ballpark Australian starting values (see README for where they come from).

const DEFAULT_RATES = {
  // Labour, per coat
  interior_wall_rate: 4.5, // $ per m2
  ceiling_rate: 4.5, // $ per m2
  trim_rate: 3, // $ per linear metre (skirting, architraves)
  door_rate: 25, // $ each (both sides + frame)
  window_rate: 16, // $ each (frame / sash)
  exterior_wall_rate: 10, // $ per m2
  exterior_trim_rate: 5, // $ per linear metre (eaves, fascia, gutters)
  exterior_door_rate: 30, // $ each
  exterior_window_rate: 22, // $ each
  primer_labour_factor: 0.6, // primer pass costs this fraction of one finish coat's labour
  // Job modifiers
  condition_fair_factor: 1.15, // prep: some patching, sanding
  condition_poor_factor: 1.35, // prep: heavy repairs, peeling, mould
  storey_2_factor: 1.25, // exterior access (ladders / scaffold)
  storey_3_factor: 1.5,
  min_charge: 300, // $ minimum labour charge per quote
  // Materials
  consumables_pct: 0.08, // tape, drop sheets, filler, sandpaper as a fraction of paint cost
  round_paint_to_tins: false, // true = charge whole tins; false = charge litres actually used
}

const PAINT_CATEGORIES = [
  { id: 'interior_wall', label: 'Interior walls' },
  { id: 'ceiling', label: 'Ceilings' },
  { id: 'trim', label: 'Trim, doors & window frames' },
  { id: 'exterior', label: 'Exterior' },
  { id: 'primer', label: 'Primer / sealer' },
]

// Ballpark starting catalogue. The two interior wall prices are Bunnings retail 10L prices
// (Nov 2026); the rest are estimates. Painters replace these with their own trade prices.
const DEFAULT_PRODUCTS = [
  { category: 'interior_wall', name: 'Taubmans Easycoat Low Sheen', pack_size_l: 10, pack_price: 161.9, coverage_m2_per_l: 12, is_default: true },
  { category: 'interior_wall', name: 'Dulux Wash&Wear Low Sheen (premium)', pack_size_l: 10, pack_price: 239, coverage_m2_per_l: 12, is_default: false },
  { category: 'ceiling', name: 'Ceiling white flat', pack_size_l: 10, pack_price: 110, coverage_m2_per_l: 12, is_default: true },
  { category: 'trim', name: 'Semi-gloss enamel', pack_size_l: 4, pack_price: 120, coverage_m2_per_l: 12, is_default: true },
  { category: 'exterior', name: 'Exterior acrylic low sheen', pack_size_l: 10, pack_price: 230, coverage_m2_per_l: 10, is_default: true },
  { category: 'primer', name: 'Primer / sealer / undercoat', pack_size_l: 10, pack_price: 130, coverage_m2_per_l: 12, is_default: true },
]

// Measuring assumptions (not per-company).
const DOOR_OPENING_M2 = 1.6 // wall area a door takes up
const WINDOW_OPENING_M2 = 1.5
const DOOR_WIDTH_M = 0.9 // skirting not run across a doorway
const TRIM_WIDTH_M = 0.15 // painted width of skirting / fascia, for paint litres
const DOOR_PAINT_M2 = 3.5 // painted area of one door, both sides + frame
const WINDOW_PAINT_M2 = 1.0 // painted area of one window frame
const WASTAGE = 1.1 // 10% allowance for cut-in, spills, absorption

const CONDITIONS = [
  { id: 'good', label: 'Good - minimal prep' },
  { id: 'fair', label: 'Fair - patching and sanding' },
  { id: 'poor', label: 'Poor - heavy repairs / peeling' },
]

const STOREYS = [
  { id: 1, label: 'Single storey' },
  { id: 2, label: 'Two storey' },
  { id: 3, label: 'Three storey' },
]

// "Other surfaces" you can add to a quote without making a whole room.
// a / b are the two numbers the painter types in; `area` / `length` / `count` is what they mean.
const EXTRA_KINDS = [
  { id: 'wall', label: 'Wall / feature wall', side: 'interior', measure: 'area', fields: ['Width (m)', 'Height (m)'] },
  { id: 'ceiling', label: 'Ceiling', side: 'interior', measure: 'area', fields: ['Length (m)', 'Width (m)'] },
  { id: 'trim', label: 'Skirting / trim', side: 'interior', measure: 'length', fields: ['Length (m)'] },
  { id: 'door', label: 'Doors', side: 'interior', measure: 'count', fields: ['How many'] },
  { id: 'window', label: 'Window frames', side: 'interior', measure: 'count', fields: ['How many'] },
  { id: 'ext_wall', label: 'Exterior wall / fence / garage door', side: 'exterior', measure: 'area', fields: ['Width (m)', 'Height (m)'] },
  { id: 'ext_trim', label: 'Eaves / fascia / gutters', side: 'exterior', measure: 'length', fields: ['Length (m)'] },
  { id: 'ext_door', label: 'Exterior doors', side: 'exterior', measure: 'count', fields: ['How many'] },
  { id: 'ext_window', label: 'Exterior windows', side: 'exterior', measure: 'count', fields: ['How many'] },
]

const num = (v) => Math.max(0, Number(v) || 0)
const round2 = (n) => Math.round(n * 100) / 100
const round1 = (n) => Math.round(n * 10) / 10

function emptyRoom(name = 'Room') {
  return {
    name,
    length: '',
    width: '',
    height: 2.4,
    doors: 1,
    windows: 1,
    ceiling: true,
    trim: true,
    paintDoors: false,
    paintWindows: false,
    source: 'measured', // 'measured' | 'estimate' (preset) | 'photo'
  }
}

function emptyExterior() {
  return {
    wallArea: '',
    otherArea: '', // fences, garage doors, etc. priced like walls
    trimLength: '',
    doors: 0,
    windows: 0,
    storeys: 1,
    source: 'measured',
  }
}

function emptyExtra(kind = 'wall', height = 2.4) {
  const def = EXTRA_KINDS.find((k) => k.id === kind) ?? EXTRA_KINDS[0]
  return {
    kind: def.id,
    label: def.label,
    a: '',
    b: def.measure === 'area' && def.fields[1] === 'Height (m)' ? height : '',
    source: 'measured',
  }
}

// What one "other surface" measures: { side, area | length | count }
function measureExtra(extra) {
  const def = EXTRA_KINDS.find((k) => k.id === extra.kind)
  if (!def) return { side: 'interior', area: 0, length: 0, count: 0 }
  const a = num(extra.a)
  const b = num(extra.b)
  return {
    side: def.side,
    area: def.measure === 'area' ? a * b : 0,
    length: def.measure === 'length' ? a : 0,
    count: def.measure === 'count' ? Math.floor(a) : 0,
  }
}

// Work out the paintable quantities for one room from its dimensions.
function measureRoom(room) {
  const l = num(room.length)
  const w = num(room.width)
  const h = num(room.height)
  const doors = Math.floor(num(room.doors))
  const windows = Math.floor(num(room.windows))
  const perimeter = 2 * (l + w)
  return {
    wallArea: Math.max(0, perimeter * h - doors * DOOR_OPENING_M2 - windows * WINDOW_OPENING_M2),
    ceilingArea: room.ceiling ? l * w : 0,
    trimLength: room.trim ? Math.max(0, perimeter - doors * DOOR_WIDTH_M) : 0,
    doorsPainted: room.paintDoors ? doors : 0,
    windowsPainted: room.paintWindows ? windows : 0,
  }
}

const productCostPerLitre = (p) => (Number(p?.pack_price) || 0) / (Number(p?.pack_size_l) || 1)

// Pick the paint product for each category: the one chosen on the quote, else the
// category's default, else the first in the category, else a built-in fallback.
function resolvePaint(products = [], selection = {}) {
  const out = {}
  for (const c of PAINT_CATEGORIES) {
    const inCat = products.filter((p) => p.category === c.id)
    out[c.id] =
      inCat.find((p) => p.id && p.id === selection[c.id]) ??
      inCat.find((p) => p.is_default) ??
      inCat[0] ??
      DEFAULT_PRODUCTS.find((p) => p.category === c.id)
  }
  return out
}

/**
 * @param {{
 *   rates: typeof DEFAULT_RATES,
 *   organization: { margin_rate: number, gst_rate: number },
 *   paint: Record<string, { name: string, pack_size_l: number, pack_price: number, coverage_m2_per_l: number }>,
 *       // one product per PAINT_CATEGORIES id - build it with resolvePaint()
 *   job: {
 *     rooms?: object[],          // interior rooms (see emptyRoom)
 *     extras?: object[],         // other surfaces (see emptyExtra)
 *     exterior?: object | null,  // exterior section (see emptyExterior), or null
 *     coats?: number,            // finish coats, default 2
 *     primer?: boolean,          // add a primer pass to walls/ceilings
 *     condition?: 'good' | 'fair' | 'poor',
 *     equipment?: { name: string, cost: number }[],
 *   }
 * }} input
 */
function calculateQuote({ rates, organization, job, paint }) {
  const r = { ...DEFAULT_RATES, ...rates }
  const products = paint ?? resolvePaint([])
  const coats = Math.max(1, Math.floor(num(job.coats) || 2))
  const primer = Boolean(job.primer)
  const rooms = job.rooms ?? []
  const extras = job.extras ?? []
  const ext = job.exterior ?? null
  const equipment = (job.equipment ?? []).filter((e) => num(e.cost) > 0)

  // --- Quantities ---
  const interior = rooms.reduce(
    (t, room) => {
      const m = measureRoom(room)
      t.wallArea += m.wallArea
      t.ceilingArea += m.ceilingArea
      t.trimLength += m.trimLength
      t.doors += m.doorsPainted
      t.windows += m.windowsPainted
      return t
    },
    { wallArea: 0, ceilingArea: 0, trimLength: 0, doors: 0, windows: 0 }
  )

  const exterior = ext
    ? {
        wallArea: num(ext.wallArea) + num(ext.otherArea),
        trimLength: num(ext.trimLength),
        doors: Math.floor(num(ext.doors)),
        windows: Math.floor(num(ext.windows)),
      }
    : { wallArea: 0, trimLength: 0, doors: 0, windows: 0 }

  // "Other surfaces" feed the same totals as rooms / exterior.
  for (const extra of extras) {
    const m = measureExtra(extra)
    const t = m.side === 'exterior' ? exterior : interior
    const kind = extra.kind
    if (kind === 'wall' || kind === 'ext_wall') t.wallArea += m.area
    else if (kind === 'ceiling') t.ceilingArea += m.area
    else if (kind === 'trim' || kind === 'ext_trim') t.trimLength += m.length
    else if (kind === 'door' || kind === 'ext_door') t.doors += m.count
    else if (kind === 'window' || kind === 'ext_window') t.windows += m.count
  }

  const storeys = Number(ext?.storeys) || 1
  const storeyFactor = storeys >= 3 ? r.storey_3_factor : storeys === 2 ? r.storey_2_factor : 1

  // --- Labour (before condition factor) ---
  const labourLines = [
    ['Interior walls', interior.wallArea * r.interior_wall_rate * coats],
    ['Ceilings', interior.ceilingArea * r.ceiling_rate * coats],
    ['Interior trim', interior.trimLength * r.trim_rate * coats],
    ['Interior doors', interior.doors * r.door_rate * coats],
    ['Interior windows', interior.windows * r.window_rate * coats],
    ['Exterior walls', exterior.wallArea * r.exterior_wall_rate * coats * storeyFactor],
    ['Exterior trim', exterior.trimLength * r.exterior_trim_rate * coats * storeyFactor],
    ['Exterior doors', exterior.doors * r.exterior_door_rate * coats * storeyFactor],
    ['Exterior windows', exterior.windows * r.exterior_window_rate * coats * storeyFactor],
  ]
  if (primer) {
    const onePass =
      interior.wallArea * r.interior_wall_rate +
      interior.ceilingArea * r.ceiling_rate +
      exterior.wallArea * r.exterior_wall_rate * storeyFactor
    labourLines.push(['Primer coat', onePass * r.primer_labour_factor])
  }

  const conditionFactor =
    job.condition === 'poor' ? r.condition_poor_factor : job.condition === 'fair' ? r.condition_fair_factor : 1
  const labourBase = labourLines.reduce((t, [, v]) => t + v, 0)
  const labourCost = labourBase === 0 ? 0 : Math.max(r.min_charge, labourBase * conditionFactor)

  // --- Paint: area to cover, per category, then litres -> tins -> cost from the catalogue ---
  const trimPaintArea =
    (interior.trimLength + exterior.trimLength) * TRIM_WIDTH_M +
    (interior.doors + exterior.doors) * DOOR_PAINT_M2 +
    (interior.windows + exterior.windows) * WINDOW_PAINT_M2

  const coverage = [
    { category: 'interior_wall', area: interior.wallArea, passes: coats },
    { category: 'ceiling', area: interior.ceilingArea, passes: coats },
    { category: 'trim', area: trimPaintArea, passes: coats },
    { category: 'exterior', area: exterior.wallArea, passes: coats },
  ]
  if (primer) {
    coverage.push({
      category: 'primer',
      area: interior.wallArea + interior.ceilingArea + exterior.wallArea,
      passes: 1,
    })
  }

  const paintLines = coverage
    .filter((c) => c.area > 0)
    .map((c) => {
      const p = products[c.category]
      const litres = (c.area * c.passes * WASTAGE) / (Number(p.coverage_m2_per_l) || 12)
      const size = Number(p.pack_size_l) || 1
      const packs = Math.ceil(litres / size - 1e-9)
      const cost = r.round_paint_to_tins ? packs * (Number(p.pack_price) || 0) : litres * productCostPerLitre(p)
      return { category: c.category, label: p.name, litres: round1(litres), packs, packSize: size, cost: round2(cost) }
    })
  const paintCost = paintLines.reduce((t, l) => t + l.cost, 0)
  const consumablesCost = paintCost * num(r.consumables_pct)
  const materialsCost = paintCost + consumablesCost

  const equipmentCost = equipment.reduce((t, e) => t + num(e.cost), 0)

  // --- Totals ---
  const subtotal = labourCost + materialsCost + equipmentCost
  const margin = subtotal * organization.margin_rate
  const preGst = subtotal + margin
  const gst = preGst * organization.gst_rate
  const total = preGst + gst

  return {
    labourCost: round2(labourCost),
    labourLines: labourLines
      .filter(([, v]) => v > 0)
      .map(([label, v]) => ({ label, amount: round2(v * (labourBase ? labourCost / labourBase : 1)) })),
    conditionFactor,
    paintLines,
    paintCost: round2(paintCost),
    consumablesCost: round2(consumablesCost),
    materialsCost: round2(materialsCost),
    equipmentCost: round2(equipmentCost),
    subtotal: round2(subtotal),
    margin: round2(margin),
    preGst: round2(preGst),
    gst: round2(gst),
    total: round2(total),
    quantities: {
      interior: roundObj(interior),
      exterior: roundObj(exterior),
      coats,
      primer,
    },
  }
}

function roundObj(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round1(v)]))
}

// Customer-safe description of the work. Never includes rates, costs or margin.
function describeScope({ job, quantities }) {
  const lines = []
  const q = quantities
  const roomNames = (job.rooms ?? [])
    .filter((r) => num(r.length) > 0 && num(r.width) > 0)
    .map((r) => r.name || 'Room')
  const extraLabels = (side) =>
    (job.extras ?? [])
      .filter((e) => {
        const m = measureExtra(e)
        return m.side === side && (m.area > 0 || m.length > 0 || m.count > 0)
      })
      .map((e) => e.label || 'Other surface')

  const hasInterior = Object.entries(q.interior).some(([, v]) => v > 0)
  if (hasInterior) {
    lines.push(`Interior painting${roomNames.length ? `: ${roomNames.join(', ')}` : ''}`)
    const parts = []
    if (q.interior.wallArea > 0) parts.push(`${q.interior.wallArea} sqm of walls`)
    if (q.interior.ceilingArea > 0) parts.push(`${q.interior.ceilingArea} sqm of ceilings`)
    if (q.interior.trimLength > 0) parts.push(`${q.interior.trimLength} m of skirting and trim`)
    if (q.interior.doors > 0) parts.push(`${q.interior.doors} door${q.interior.doors === 1 ? '' : 's'}`)
    if (q.interior.windows > 0) parts.push(`${q.interior.windows} window frame${q.interior.windows === 1 ? '' : 's'}`)
    if (parts.length) lines.push(parts.join(', '))
    const more = extraLabels('interior')
    if (more.length) lines.push(`Also includes: ${more.join(', ')}`)
  }
  const hasExterior = Object.entries(q.exterior).some(([, v]) => v > 0)
  if (hasExterior) {
    lines.push('Exterior painting')
    const parts = []
    if (q.exterior.wallArea > 0) parts.push(`${q.exterior.wallArea} sqm of exterior surfaces`)
    if (q.exterior.trimLength > 0) parts.push(`${q.exterior.trimLength} m of eaves, fascia and gutters`)
    if (q.exterior.doors > 0) parts.push(`${q.exterior.doors} door${q.exterior.doors === 1 ? '' : 's'}`)
    if (q.exterior.windows > 0) parts.push(`${q.exterior.windows} window${q.exterior.windows === 1 ? '' : 's'}`)
    if (parts.length) lines.push(parts.join(', '))
    const more = extraLabels('exterior')
    if (more.length) lines.push(`Also includes: ${more.join(', ')}`)
  }
  lines.push(`${q.coats} finish coat${q.coats === 1 ? '' : 's'}${q.primer ? ' over a primer coat' : ''}`)
  if (job.condition === 'fair') lines.push('Includes patching and sanding of surfaces')
  if (job.condition === 'poor') lines.push('Includes extensive surface repair and preparation')
  return lines
}

// True if any measurement on the quote came from a preset or a photo and hasn't been
// confirmed by hand. The customer PDF then says sizes are estimates.
function hasEstimates(job) {
  const flagged = (x) => x && (x.source === 'estimate' || x.source === 'photo')
  return (job.rooms ?? []).some(flagged) || (job.extras ?? []).some(flagged) || flagged(job.exterior)
}


// Typical Australian room sizes, used to add a room in one tap before it's measured.
// They're estimates - the room card is flagged "estimated size" until the painter edits it.
const ROOM_PRESETS = [
  { id: 'bed-s', label: 'Small bedroom', length: 3.0, width: 3.0, doors: 1, windows: 1 },
  { id: 'bed', label: 'Bedroom', length: 3.5, width: 3.5, doors: 1, windows: 1 },
  { id: 'master', label: 'Master bedroom', length: 4.5, width: 4.0, doors: 1, windows: 2 },
  { id: 'living', label: 'Living room', length: 5.0, width: 4.5, doors: 2, windows: 2 },
  { id: 'dining', label: 'Dining room', length: 4.0, width: 3.5, doors: 1, windows: 1 },
  { id: 'kitchen', label: 'Kitchen', length: 4.0, width: 3.0, doors: 1, windows: 1 },
  { id: 'bath', label: 'Bathroom', length: 2.5, width: 2.0, doors: 1, windows: 1 },
  { id: 'ensuite', label: 'Ensuite', length: 2.2, width: 2.0, doors: 1, windows: 1 },
  { id: 'toilet', label: 'Toilet', length: 1.5, width: 1.0, doors: 1, windows: 0 },
  { id: 'laundry', label: 'Laundry', length: 2.5, width: 2.0, doors: 1, windows: 1 },
  { id: 'hall', label: 'Hallway', length: 6.0, width: 1.1, doors: 4, windows: 0 },
  { id: 'study', label: 'Study', length: 3.0, width: 3.0, doors: 1, windows: 1 },
  { id: 'entry', label: 'Entry', length: 2.5, width: 2.0, doors: 1, windows: 0 },
]

const CEILING_HEIGHTS = [2.4, 2.55, 2.7, 3.0]

function roomFromPreset(preset, height = 2.4) {
  return {
    ...emptyRoom(preset.label),
    length: preset.length,
    width: preset.width,
    height,
    doors: preset.doors,
    windows: preset.windows,
    source: 'estimate',
  }
}

return { DEFAULT_RATES, PAINT_CATEGORIES, DEFAULT_PRODUCTS, DOOR_OPENING_M2, WINDOW_OPENING_M2, DOOR_WIDTH_M, TRIM_WIDTH_M, DOOR_PAINT_M2, WINDOW_PAINT_M2, WASTAGE, CONDITIONS, STOREYS, EXTRA_KINDS, emptyRoom, emptyExterior, emptyExtra, measureExtra, measureRoom, productCostPerLitre, resolvePaint, calculateQuote, describeScope, hasEstimates, ROOM_PRESETS, CEILING_HEIGHTS, roomFromPreset }
})
