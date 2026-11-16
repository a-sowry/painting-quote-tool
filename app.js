/* PaintQuote demo - plain JS, no build step. Data lives in this browser (localStorage). */
(function () {
  'use strict'
  var P = window.PQ
  var KEY = 'pq.v1'
  var $ = function (s, r) { return (r || document).querySelector(s) }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  var money = function (n) { return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
  var money0 = function (n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-AU') }
  var uid = function () { return Math.random().toString(36).slice(2, 9) }

  // ---------- storage (localStorage, with in-memory fallback) ----------
  var mem = null
  function load() {
    try { var s = localStorage.getItem(KEY); if (s) return JSON.parse(s) } catch (e) {}
    return mem
  }
  function save() {
    mem = state
    try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {}
  }
  function defaults() {
    return {
      org: { name: 'Your Painting Co', abn: '', phone: '', email: '', margin_rate: 0.25, gst_rate: 0.1, quote_prefix: 'Q', next_number: 1001, valid_days: 30 },
      rates: Object.assign({}, P.DEFAULT_RATES),
      products: P.DEFAULT_PRODUCTS.map(function (p) { return Object.assign({ id: uid() }, p) }),
      quotes: [],
      draft: newDraft()
    }
  }
  function newDraft() {
    return {
      id: uid(), customer: { name: '', address: '', phone: '', email: '' },
      job: { rooms: [], extras: [], exterior: null, coats: 2, primer: false, condition: 'good', equipment: [] },
      selection: {}, notes: '', height: 2.4
    }
  }
  var state = load() || defaults()
  // make sure older saved data has every field
  state.rates = Object.assign({}, P.DEFAULT_RATES, state.rates)
  state.org = Object.assign(defaults().org, state.org)
  if (!state.draft) state.draft = newDraft()
  var tab = 'quote'

  // ---------- calculation ----------
  function calc(d) {
    d = d || state.draft
    var paint = P.resolvePaint(state.products, d.selection)
    return P.calculateQuote({ rates: state.rates, organization: state.org, job: d.job, paint: paint })
  }

  // ---------- render ----------
  function render() {
    $('#nav').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab) })
    var app = $('#app')
    var y = window.scrollY
    if (tab === 'quote') app.innerHTML = viewQuote()
    else if (tab === 'history') app.innerHTML = viewHistory()
    else app.innerHTML = viewPrices()
    if (tab === 'quote') renderBar(); else removeBar()
    window.scrollTo(0, y)
  }

  function num(v, step, min) {
    return '<input type="number" inputmode="decimal" step="' + (step || 'any') + '" min="' + (min == null ? 0 : min) + '" '
  }

  // ----- quote view -----
  function viewQuote() {
    var d = state.draft, j = d.job
    var h = ''
    h += '<div class="card"><h2>Customer</h2>'
    h += '<div class="row"><div><label>Name</label><input data-f="customer.name" value="' + esc(d.customer.name) + '" placeholder="e.g. Sam Taylor"></div>'
    h += '<div><label>Phone</label><input data-f="customer.phone" inputmode="tel" value="' + esc(d.customer.phone) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div style="flex:2 1 200px"><label>Job address</label><input data-f="customer.address" value="' + esc(d.customer.address) + '"></div>'
    h += '<div><label>Email</label><input data-f="customer.email" inputmode="email" value="' + esc(d.customer.email) + '"></div></div></div>'

    // quick add rooms
    h += '<div class="card"><h2>Add rooms</h2>'
    h += '<div class="row" style="margin-bottom:10px"><div style="flex:0 0 150px"><label>Ceiling height</label><select data-f="height" data-num="1">'
    P.CEILING_HEIGHTS.forEach(function (c) { h += '<option value="' + c + '"' + (Number(d.height) === c ? ' selected' : '') + '>' + c + ' m' + (c === 2.4 ? ' (standard)' : '') + '</option>' })
    h += '</select></div></div>'
    h += '<div class="chips">'
    P.ROOM_PRESETS.forEach(function (p) { h += '<button class="chip" data-act="addroom" data-id="' + p.id + '">+ ' + esc(p.label) + '</button>' })
    h += '<button class="chip" data-act="addblank">+ Custom room</button></div>'
    h += '<p class="note" style="margin:8px 0 0">Tap a room to add it at a typical size, then change the sizes if you have measured it.</p>'
    h += '<div id="rooms">'
    if (!j.rooms.length) h += '<div class="empty">No rooms yet.</div>'
    j.rooms.forEach(function (r, i) { h += roomCard(r, i) })
    h += '</div></div>'

    // other surfaces
    h += '<div class="card"><h2>Other surfaces</h2><p class="note" style="margin:0 0 8px">Feature walls, extra ceilings, doors, fences, eaves &mdash; anything not in a room above.</p>'
    h += '<div class="row"><div style="flex:2 1 220px"><label>Add</label><select id="extraKind">'
    P.EXTRA_KINDS.forEach(function (k) { h += '<option value="' + k.id + '">' + esc(k.label) + '</option>' })
    h += '</select></div><div style="flex:0 0 auto"><button class="btn sec" data-act="addextra">Add</button></div></div>'
    j.extras.forEach(function (x, i) { h += extraCard(x, i) })
    h += '</div>'

    // exterior
    h += '<div class="card"><h2>Exterior</h2>'
    if (!j.exterior) {
      h += '<button class="btn sec" data-act="addext">+ Add exterior painting</button>'
    } else {
      var e = j.exterior
      h += '<div class="row"><div><label>Wall area (sqm)</label>' + num() + 'data-f="job.exterior.wallArea" data-clr="1" value="' + esc(e.wallArea) + '"></div>'
      h += '<div><label>Eaves/fascia/gutters (m)</label>' + num() + 'data-f="job.exterior.trimLength" data-clr="1" value="' + esc(e.trimLength) + '"></div></div>'
      h += '<div class="row" style="margin-top:8px"><div><label>Doors</label>' + num(1) + 'data-f="job.exterior.doors" data-clr="1" value="' + esc(e.doors) + '"></div>'
      h += '<div><label>Windows</label>' + num(1) + 'data-f="job.exterior.windows" data-clr="1" value="' + esc(e.windows) + '"></div>'
      h += '<div><label>Storeys</label><select data-f="job.exterior.storeys" data-num="1">'
      P.STOREYS.forEach(function (s) { h += '<option value="' + s.id + '"' + (Number(e.storeys) === s.id ? ' selected' : '') + '>' + esc(s.label) + '</option>' })
      h += '</select></div></div>'
      h += '<div class="sum">Not sure of the wall area? A typical single-storey house is about 150&ndash;220 sqm of wall.</div>'
      if (e.source !== 'measured') h += '<div class="sum"><span class="tag">estimated size</span></div>'
      h += '<div style="margin-top:8px"><button class="link red" data-act="rmext">Remove exterior</button></div>'
    }
    h += '</div>'

    // job options
    h += '<div class="card"><h2>Job options</h2><div class="row">'
    h += '<div><label>Finish coats</label><select data-f="job.coats" data-num="1">'
    ;[1, 2, 3].forEach(function (c) { h += '<option value="' + c + '"' + (Number(j.coats) === c ? ' selected' : '') + '>' + c + '</option>' })
    h += '</select></div><div style="flex:2 1 200px"><label>Surface condition</label><select data-f="job.condition">'
    P.CONDITIONS.forEach(function (c) { h += '<option value="' + c.id + '"' + (j.condition === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>' })
    h += '</select></div></div>'
    h += '<div style="margin-top:10px"><label class="chk"><input type="checkbox" data-f="job.primer" data-bool="1"' + (j.primer ? ' checked' : '') + '> Add a primer / sealer coat</label></div>'
    h += '<h3>Paint</h3>'
    P.PAINT_CATEGORIES.forEach(function (c) {
      var list = state.products.filter(function (p) { return p.category === c.id })
      if (!list.length) return
      var cur = P.resolvePaint(state.products, d.selection)[c.id]
      h += '<div class="row" style="margin-bottom:6px"><div><label>' + esc(c.label) + '</label><select data-sel="' + c.id + '">'
      list.forEach(function (p) { h += '<option value="' + p.id + '"' + (cur && cur.id === p.id ? ' selected' : '') + '>' + esc(p.name) + ' &mdash; ' + money(p.pack_price) + ' / ' + p.pack_size_l + 'L</option>' })
      h += '</select></div></div>'
    })
    h += '<h3>Extras (scaffold, subcontractors, hire)</h3>'
    j.equipment.forEach(function (q, i) {
      h += '<div class="row" style="margin-bottom:6px"><div style="flex:2 1 150px"><input data-f="job.equipment.' + i + '.name" value="' + esc(q.name) + '" placeholder="Item"></div><div style="flex:1 1 80px">' + num() + 'data-f="job.equipment.' + i + '.cost" data-clr="1" value="' + esc(q.cost) + '" placeholder="$ cost"></div><div style="flex:0 0 auto"><button class="link red" data-act="rmequip" data-i="' + i + '">&times;</button></div></div>'
    })
    h += '<button class="btn sec sm" data-act="addequip">+ Add item</button>'
    h += '<h3>Notes for the customer</h3><textarea rows="2" data-f="notes" placeholder="e.g. Colours to be confirmed. Furniture moved by owner.">' + esc(d.notes) + '</textarea>'
    h += '</div>'

    // breakdown (painter only)
    h += '<div class="card" id="breakdown">' + breakdown() + '</div>'
    return h
  }

  function roomCard(r, i) {
    var m = P.measureRoom(r)
    var h = '<div class="room"><div class="head"><input data-f="job.rooms.' + i + '.name" value="' + esc(r.name) + '">'
    if (r.source === 'estimate') h += '<span class="tag">estimated size</span>'
    if (r.source === 'photo') h += '<span class="tag photo">from photo</span>'
    h += '<button class="link" data-act="dup" data-i="' + i + '" title="Copy">Copy</button><button class="link red" data-act="rmroom" data-i="' + i + '">&times;</button></div>'
    h += '<div class="row"><div><label>Length (m)</label>' + num() + 'data-f="job.rooms.' + i + '.length" data-room="1" value="' + esc(r.length) + '"></div>'
    h += '<div><label>Width (m)</label>' + num() + 'data-f="job.rooms.' + i + '.width" data-room="1" value="' + esc(r.width) + '"></div>'
    h += '<div><label>Height (m)</label>' + num() + 'data-f="job.rooms.' + i + '.height" data-room="1" value="' + esc(r.height) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Doors</label>' + num(1) + 'data-f="job.rooms.' + i + '.doors" data-room="1" value="' + esc(r.doors) + '"></div>'
    h += '<div><label>Windows</label>' + num(1) + 'data-f="job.rooms.' + i + '.windows" data-room="1" value="' + esc(r.windows) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px;gap:12px">'
    ;[['ceiling', 'Ceiling'], ['trim', 'Skirting'], ['paintDoors', 'Doors'], ['paintWindows', 'Window frames']].forEach(function (c) {
      h += '<label class="chk"><input type="checkbox" data-f="job.rooms.' + i + '.' + c[0] + '" data-bool="1"' + (r[c[0]] ? ' checked' : '') + '> ' + c[1] + '</label>'
    })
    h += '</div><div class="sum" id="rs' + i + '">' + roomSummary(m) + '</div></div>'
    return h
  }
  function roomSummary(m) {
    var p = [Math.round(m.wallArea) + ' sqm walls']
    if (m.ceilingArea) p.push(Math.round(m.ceilingArea) + ' sqm ceiling')
    if (m.trimLength) p.push(Math.round(m.trimLength) + ' m skirting')
    return p.join(' · ')
  }

  function extraCard(x, i) {
    var def = P.EXTRA_KINDS.filter(function (k) { return k.id === x.kind })[0]
    var h = '<div class="room"><div class="head"><b style="flex:1">' + esc(x.label) + '</b>'
    if (x.source === 'estimate') h += '<span class="tag">estimated size</span>'
    if (x.source === 'photo') h += '<span class="tag photo">from photo</span>'
    h += '<button class="link red" data-act="rmextra" data-i="' + i + '">&times;</button></div><div class="row">'
    h += '<div><label>' + esc(def.fields[0]) + '</label>' + num(def.measure === 'count' ? 1 : 'any') + 'data-f="job.extras.' + i + '.a" data-clr="1" value="' + esc(x.a) + '"></div>'
    if (def.fields[1]) h += '<div><label>' + esc(def.fields[1]) + '</label>' + num() + 'data-f="job.extras.' + i + '.b" data-clr="1" value="' + esc(x.b) + '"></div>'
    h += '</div></div>'
    return h
  }

  function breakdown() {
    var q = calc(), d = state.draft
    var h = '<h2>Price breakdown <span class="note">(only you see this)</span></h2>'
    if (q.total === 0) return h + '<div class="empty">Add a room to see the price.</div>'
    h += '<table>'
    q.labourLines.forEach(function (l) { h += '<tr><td>' + esc(l.label) + '</td><td class="r">' + money(l.amount) + '</td></tr>' })
    h += '<tr><td><b>Labour</b>' + (q.conditionFactor > 1 ? ' <span class="note">(incl. prep x' + q.conditionFactor + ')</span>' : '') + '</td><td class="r"><b>' + money(q.labourCost) + '</b></td></tr>'
    q.paintLines.forEach(function (l) { h += '<tr><td>' + esc(l.label) + ' <span class="note">' + l.litres + ' L (' + l.packs + ' x ' + l.packSize + 'L)</span></td><td class="r">' + money(l.cost) + '</td></tr>' })
    h += '<tr><td>Consumables (tape, sheets, filler)</td><td class="r">' + money(q.consumablesCost) + '</td></tr>'
    h += '<tr><td><b>Materials</b></td><td class="r"><b>' + money(q.materialsCost) + '</b></td></tr>'
    if (q.equipmentCost) h += '<tr><td><b>Extras</b></td><td class="r"><b>' + money(q.equipmentCost) + '</b></td></tr>'
    h += '<tr><td>Subtotal</td><td class="r">' + money(q.subtotal) + '</td></tr>'
    h += '<tr><td>Margin (' + Math.round(state.org.margin_rate * 100) + '%)</td><td class="r">' + money(q.margin) + '</td></tr>'
    h += '<tr><td>GST (' + Math.round(state.org.gst_rate * 100) + '%)</td><td class="r">' + money(q.gst) + '</td></tr>'
    h += '<tr><td><b>Total</b></td><td class="r"><b>' + money(q.total) + '</b></td></tr></table>'
    return h
  }

  function renderBar() {
    var q = calc()
    var bar = $('#bar')
    if (!bar) { bar = document.createElement('div'); bar.id = 'bar'; bar.className = 'bar'; document.body.appendChild(bar) }
    bar.innerHTML = '<div class="in"><div class="tot"><small>Total inc GST</small><b>' + money0(q.total) + '</b></div>' +
      '<button class="btn sec" data-act="clear">New</button><button class="btn sec" data-act="save">Save</button><button class="btn acc" data-act="pdf">Customer PDF</button></div>'
  }
  function removeBar() { var b = $('#bar'); if (b) b.remove() }

  function updateLive() {
    var b = $('#breakdown'); if (b) b.innerHTML = breakdown()
    renderBar()
    state.draft.job.rooms.forEach(function (r, i) { var el = $('#rs' + i); if (el) el.textContent = roomSummary(P.measureRoom(r)) })
  }

  // ----- history view -----
  function viewHistory() {
    var h = '<div class="card"><h2>Saved quotes</h2>'
    if (!state.quotes.length) return h + '<div class="empty">Nothing saved yet. Build a quote and tap Save.</div></div>'
    h += '<table>'
    state.quotes.slice().reverse().forEach(function (s) {
      var i = state.quotes.indexOf(s)
      h += '<tr><td><b>' + esc(s.number) + '</b><br><span class="note">' + esc(s.customer.name || 'No name') + ' · ' + esc(s.date) + '</span></td><td class="r">' + money0(s.total) + '</td><td class="r"><button class="link" data-act="openq" data-i="' + i + '">Open</button><button class="link red" data-act="delq" data-i="' + i + '">&times;</button></td></tr>'
    })
    return h + '</table></div>'
  }

  // ----- prices view -----
  var RATE_LABELS = [
    ['Labour per coat', null],
    ['interior_wall_rate', 'Interior walls ($/sqm)'], ['ceiling_rate', 'Ceilings ($/sqm)'], ['trim_rate', 'Skirting / trim ($/m)'],
    ['door_rate', 'Interior door ($ each)'], ['window_rate', 'Interior window frame ($ each)'],
    ['exterior_wall_rate', 'Exterior walls ($/sqm)'], ['exterior_trim_rate', 'Eaves / fascia ($/m)'],
    ['exterior_door_rate', 'Exterior door ($ each)'], ['exterior_window_rate', 'Exterior window ($ each)'],
    ['Job modifiers', null],
    ['primer_labour_factor', 'Primer coat labour (x one coat)'], ['condition_fair_factor', 'Prep factor: fair'], ['condition_poor_factor', 'Prep factor: poor'],
    ['storey_2_factor', 'Two-storey access factor'], ['storey_3_factor', 'Three-storey access factor'],
    ['min_charge', 'Minimum labour charge ($)'], ['consumables_pct', 'Consumables (fraction of paint cost)']
  ]
  function viewPrices() {
    var h = '<div class="hint">These are ballpark starting prices. Change them to your own &mdash; every quote uses whatever is here.</div>'
    h += '<div class="card"><h2>Your business</h2><div class="row"><div style="flex:2 1 200px"><label>Business name</label><input data-f="org.name" value="' + esc(state.org.name) + '"></div><div><label>ABN</label><input data-f="org.abn" value="' + esc(state.org.abn) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Phone</label><input data-f="org.phone" value="' + esc(state.org.phone) + '"></div><div><label>Email</label><input data-f="org.email" value="' + esc(state.org.email) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Margin (%)</label>' + num() + 'data-f="org.margin_rate" data-pct="1" value="' + Math.round(state.org.margin_rate * 1000) / 10 + '"></div><div><label>GST (%)</label>' + num() + 'data-f="org.gst_rate" data-pct="1" value="' + Math.round(state.org.gst_rate * 1000) / 10 + '"></div><div><label>Quote valid (days)</label>' + num(1) + 'data-f="org.valid_days" value="' + esc(state.org.valid_days) + '"></div></div></div>'
    h += '<div class="card"><h2>Labour rates</h2>'
    RATE_LABELS.forEach(function (r) {
      if (r[1] === null) { h += '<h3>' + esc(r[0]) + '</h3>'; return }
      h += '<div class="row" style="margin-bottom:6px;align-items:center"><div style="flex:2 1 170px">' + esc(r[1]) + '</div><div style="flex:0 0 110px">' + num() + 'data-f="rates.' + r[0] + '" value="' + esc(state.rates[r[0]]) + '"></div></div>'
    })
    h += '<div style="margin-top:8px"><label class="chk"><input type="checkbox" data-f="rates.round_paint_to_tins" data-bool="1"' + (state.rates.round_paint_to_tins ? ' checked' : '') + '> Charge whole tins (not just litres used)</label></div></div>'
    h += '<div class="card"><h2>Paint &amp; materials</h2>'
    P.PAINT_CATEGORIES.forEach(function (c) {
      h += '<h3>' + esc(c.label) + '</h3>'
      state.products.forEach(function (p, i) {
        if (p.category !== c.id) return
        h += '<div class="room"><div class="head"><input data-f="products.' + i + '.name" value="' + esc(p.name) + '"><button class="link red" data-act="rmprod" data-i="' + i + '">&times;</button></div>'
        h += '<div class="row"><div><label>Tin size (L)</label>' + num() + 'data-f="products.' + i + '.pack_size_l" value="' + esc(p.pack_size_l) + '"></div>'
        h += '<div><label>Tin price ($)</label>' + num() + 'data-f="products.' + i + '.pack_price" value="' + esc(p.pack_price) + '"></div>'
        h += '<div><label>Coverage (sqm/L)</label>' + num() + 'data-f="products.' + i + '.coverage_m2_per_l" value="' + esc(p.coverage_m2_per_l) + '"></div></div>'
        h += '<label class="chk" style="margin-top:8px"><input type="radio" name="def-' + c.id + '" data-act="setdef" data-i="' + i + '"' + (p.is_default ? ' checked' : '') + '> Use by default</label></div>'
      })
      h += '<button class="btn sec sm" style="margin-top:8px" data-act="addprod" data-cat="' + c.id + '">+ Add ' + esc(c.label.toLowerCase()) + ' product</button>'
    })
    h += '</div><div class="card"><button class="btn sec" data-act="reset">Reset everything to demo defaults</button></div>'
    return h
  }

  // ---------- events ----------
  function setPath(path, val) {
    var parts = path.split('.'), o = state
    for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]]
    o[parts[parts.length - 1]] = val
  }
  // typing in a size field means the painter has now confirmed it by hand
  function confirmSource(path) {
    var m = path.match(/^job\.(rooms|extras)\.(\d+)\./)
    var tgt = null
    if (m) tgt = state.draft.job[m[1]][Number(m[2])]
    else if (/^job\.exterior\./.test(path)) tgt = state.draft.job.exterior
    if (tgt && tgt.source !== 'measured') { tgt.source = 'measured'; return true }
    return false
  }
  function fieldVal(el) {
    if (el.dataset.bool) return el.checked
    if (el.type === 'number') return el.value === '' ? '' : Number(el.value)
    if (el.dataset.num) return Number(el.value)
    return el.value
  }

  document.addEventListener('input', function (e) {
    var el = e.target
    if (el.dataset.sel) { state.draft.selection[el.dataset.sel] = el.value; save(); updateLive(); return }
    var f = el.dataset.f
    if (!f || el.type === 'radio') return
    var v = fieldVal(el)
    if (el.dataset.pct) v = (Number(el.value) || 0) / 100
    var path = /^(org|rates|products)\./.test(f) ? f : 'draft.' + f
    var realPath = path.replace(/^draft\.(customer|notes|height)/, 'draft.$1')
    setPath(realPath, v)
    var changed = (el.dataset.room || el.dataset.clr) ? confirmSource(realPath.replace(/^draft\./, '')) : false
    save()
    if (tab === 'quote') {
      if (changed) { var a = document.activeElement; var id = a && a.getAttribute('data-f'); render(); if (id) { var n = document.querySelector('[data-f="' + id + '"]'); if (n) { n.focus(); try { n.setSelectionRange(n.value.length, n.value.length) } catch (x) {} } } }
      else updateLive()
    }
  })
  document.addEventListener('change', function (e) {
    var el = e.target
    if (el.dataset.act === 'setdef') {
      var i = Number(el.dataset.i), cat = state.products[i].category
      state.products.forEach(function (p) { if (p.category === cat) p.is_default = false })
      state.products[i].is_default = true; save(); return
    }
    // selects & checkboxes re-render the quote so summaries/paint lists stay right
    if (tab === 'quote' && (el.tagName === 'SELECT' || el.type === 'checkbox')) { setTimeout(render, 0) }
  })

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('#nav button')
    if (nav) { tab = nav.dataset.tab; render(); window.scrollTo(0, 0); return }
    var b = e.target.closest('[data-act]')
    if (!b || b.type === 'radio') return
    var act = b.dataset.act, i = Number(b.dataset.i), d = state.draft, j = d.job
    if (act === 'addroom') {
      var p = P.ROOM_PRESETS.filter(function (x) { return x.id === b.dataset.id })[0]
      j.rooms.push(P.roomFromPreset(p, Number(d.height) || 2.4))
    } else if (act === 'addblank') { var r = P.emptyRoom('Room ' + (j.rooms.length + 1)); r.height = Number(d.height) || 2.4; j.rooms.push(r) }
    else if (act === 'dup') { var c = JSON.parse(JSON.stringify(j.rooms[i])); c.name += ' (copy)'; j.rooms.splice(i + 1, 0, c) }
    else if (act === 'rmroom') j.rooms.splice(i, 1)
    else if (act === 'addextra') { j.extras.push(P.emptyExtra($('#extraKind').value, Number(d.height) || 2.4)) }
    else if (act === 'rmextra') j.extras.splice(i, 1)
    else if (act === 'addext') j.exterior = P.emptyExterior()
    else if (act === 'rmext') j.exterior = null
    else if (act === 'addequip') j.equipment.push({ name: '', cost: '' })
    else if (act === 'rmequip') j.equipment.splice(i, 1)
    else if (act === 'save') return saveQuote()
    else if (act === 'pdf') return printQuote()
    else if (act === 'clear') { if (confirm('Start a new blank quote?')) state.draft = newDraft(); else return }
    else if (act === 'openq') { state.draft = JSON.parse(JSON.stringify(state.quotes[i].draft)); tab = 'quote' }
    else if (act === 'delq') { if (confirm('Delete this saved quote?')) state.quotes.splice(i, 1); else return }
    else if (act === 'rmprod') { if (state.products.filter(function (x) { return x.category === state.products[i].category }).length > 1) { state.products.splice(i, 1) } else { alert('Keep at least one product in each group.'); return } }
    else if (act === 'addprod') { state.products.push({ id: uid(), category: b.dataset.cat, name: 'New product', pack_size_l: 10, pack_price: 100, coverage_m2_per_l: 12, is_default: false }) }
    else if (act === 'reset') { if (confirm('Reset all prices, paint and saved quotes to the demo defaults?')) { state = defaults(); tab = 'quote' } else return }
    else return
    save(); render()
  })

  function saveQuote() {
    var d = state.draft, q = calc(d)
    if (!q.total) { alert('Add at least one room or surface first.'); return }
    var existing = state.quotes.filter(function (s) { return s.draft.id === d.id })[0]
    var number = existing ? existing.number : state.org.quote_prefix + state.org.next_number++
    var rec = { number: number, date: today(), customer: d.customer, total: q.total, draft: JSON.parse(JSON.stringify(d)) }
    if (existing) state.quotes[state.quotes.indexOf(existing)] = rec; else state.quotes.push(rec)
    save(); toast('Saved as ' + number)
  }
  function today() { return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) }
  function toast(t) {
    var n = document.createElement('div'); n.textContent = t
    n.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#1c2430;color:#fff;padding:10px 16px;border-radius:99px;z-index:20;font-size:14px'
    document.body.appendChild(n); setTimeout(function () { n.remove() }, 1800)
  }

  // ---------- customer quote document (print / save as PDF) ----------
  // Shows scope, ex-GST, GST and total only. Never labour, materials, margin or extras.
  function buildDoc() {
    var d = state.draft, q = calc(d), o = state.org
    var scope = P.describeScope({ job: d.job, quantities: q.quantities })
    var existing = state.quotes.filter(function (s) { return s.draft.id === d.id })[0]
    var number = existing ? existing.number : state.org.quote_prefix + state.org.next_number
    var h = '<div class="doc"><div class="hd"><div><h1>' + esc(o.name) + '</h1><div class="meta">' + [o.abn && 'ABN ' + esc(o.abn), esc(o.phone), esc(o.email)].filter(Boolean).join(' · ') + '</div></div>'
    h += '<div style="text-align:right"><b style="font-size:20px">QUOTE</b><div class="meta">' + esc(number) + '<br>' + esc(today()) + '<br>Valid ' + esc(o.valid_days) + ' days</div></div></div>'
    h += '<div><b>Prepared for</b><br>' + esc(d.customer.name || '—') + (d.customer.address ? '<br>' + esc(d.customer.address) : '') + '</div>'
    h += '<div class="scope"><b>Scope of work</b><ul>' + scope.map(function (l) { return '<li>' + esc(l) + '</li>' }).join('') + '</ul></div>'
    if (d.notes) h += '<div><b>Notes</b><br>' + esc(d.notes).replace(/\n/g, '<br>') + '</div>'
    h += '<div class="totals"><div><span>Total (ex GST)</span><span>' + money(q.preGst) + '</span></div><div><span>GST</span><span>' + money(q.gst) + '</span></div><div class="g"><span>Total</span><span>' + money(q.total) + '</span></div></div>'
    h += '<div class="fine">' + (P.hasEstimates(d.job) ? 'Some room sizes are estimates. The price will be confirmed after final measurement on site. ' : '') + 'Paint, materials and labour are included. Quote is valid for ' + esc(o.valid_days) + ' days.</div></div>'
    return h
  }
  function printQuote() {
    var q = calc()
    if (!q.total) { alert('Add at least one room or surface first.'); return }
    $('#printdoc').innerHTML = buildDoc()
    window.print()
  }

  window.__pq = { state: function () { return state }, calc: calc, buildDoc: buildDoc }
  render()
})()
