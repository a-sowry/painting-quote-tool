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
  function localSave() {
    mem = state
    try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {}
  }
  function save() { localSave(); scheduleSync() }
  function defaults() {
    return {
      org: { name: 'Your Painting Co', abn: '', phone: '', email: '', margin_rate: 0.25, gst_rate: 0.1, quote_prefix: 'Q', next_number: 1001, valid_days: 30, licence: '' },
      rates: Object.assign({}, P.DEFAULT_RATES),
      products: P.DEFAULT_PRODUCTS.map(function (p) { return Object.assign({ id: uid() }, p) }),
      services: P.defaultServices(),
      profile: defaultProfile(),
      onboarded: false,
      quotes: [],
      draft: newDraft()
    }
  }
  function defaultProfile() { return { interior: true, exterior: true, homes: { qld: false, brick: false, unit: false } } }
  function newDraft() {
    return {
      id: uid(), customer: { name: '', address: '', phone: '', email: '' },
      job: { rooms: [], extras: [], custom: [], exterior: null, coats: 2, primer: false, condition: 'good', equipment: [] },
      selection: {}, notes: '', height: 2.4
    }
  }
  var state = load() || defaults()
  // make sure older / pulled data has every field
  function normalise() {
    state.rates = Object.assign({}, P.DEFAULT_RATES, state.rates)
    state.org = Object.assign(defaults().org, state.org)
    if (!state.draft) state.draft = newDraft()
    if (!state.draft.job.custom) state.draft.job.custom = []
    if (!state.services) state.services = P.defaultServices()
    P.defaultServices().forEach(function (d) { if (!state.services.some(function (x) { return x.id === d.id })) state.services.push(d) })
    if (state.onboarded === undefined) state.onboarded = false
    if (!state.profile) state.profile = defaultProfile()
    if (!state.profile.homes) state.profile.homes = { qld: false, brick: false, unit: false }
    if (!state.products || !state.products.length) state.products = defaults().products
    if (!state.quotes) state.quotes = []
    if (!state.pendingQ) state.pendingQ = []
  }
  normalise()
  var obStep = 1
  var cfg = window.PQ_CONFIG || {}
  var sb = null, cloudUser = null, syncTimer = null, lastPushed = '', syncMsg = '', authMode = 'login', authMsg = '', authBusy = false
  try {
    if (cfg.SUPABASE_URL && cfg.SUPABASE_KEY && window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pq-auth', detectSessionInUrl: true } })
    }
  } catch (e) { sb = null }
  var tab = state.onboarded ? 'quote' : (sb && !state.skipAuth ? 'loading' : 'onboard')
  var BARE_TABS = ['onboard', 'welcome', 'auth', 'recover', 'loading']

  // ---------- services ----------
  function enabledMap() { var m = {}; state.services.forEach(function (s) { if (s.builtin) m[s.id] = s.enabled !== false }); return m }
  var QLD_EXTERIOR = ['balustrade', 'verandah_ceiling', 'lattice', 'stumps', 'scaffold']
  var EXTERIOR_OTHER = ['fence', 'deck', 'roof', 'garage_door', 'pressure_wash']
  // Pre-tick services from the "what do you paint?" answers. The painter can still change every tick.
  function applyProfile() {
    var p = state.profile, on = function (id, v) { state.services.forEach(function (s) { if (s.id === id) s.enabled = v }) }
    P.BUILTIN_SERVICES.forEach(function (b) { on(b.id, b.group === 'interior' ? !!p.interior : !!p.exterior) })
    EXTERIOR_OTHER.forEach(function (id) { if (!p.exterior) on(id, false) })
    var anyQld = p.homes.qld
    QLD_EXTERIOR.forEach(function (id) { on(id, !!(anyQld && p.exterior)) })
    on('lead_test', !!anyQld); on('lead_safe', !!anyQld)
    if (anyQld && p.exterior) { on('roof', true) }
  }
  function houseOrder() {
    var key = { queenslander: 'qld', highset: 'qld', lowset: 'brick', townhouse: 'unit', unit: 'unit' }, h = state.profile.homes
    var mine = P.HOUSE_TEMPLATES.filter(function (t) { return h[key[t.id]] }), rest = P.HOUSE_TEMPLATES.filter(function (t) { return !h[key[t.id]] })
    return mine.concat(rest)
  }
  function showHeritage(j) { var h = state.profile.homes; return j.heritage || h.qld || (!h.brick && !h.unit) }
  function svcOn(id) { var s = state.services.filter(function (x) { return x.id === id })[0]; return !s || s.enabled !== false }
  function unitLabel(u) { return P.UNITS.filter(function (x) { return x.id === u })[0].label }
  function unitShort(u) { return { sqm: 'sqm', m: 'metres', each: 'how many', hour: 'hours', fixed: '' }[u] }
  function newId() { return 'c' + uid() }
  function catVisible(c) {
    if (c === 'interior_wall') return svcOn('interior_wall')
    if (c === 'ceiling') return svcOn('ceiling')
    if (c === 'trim') return svcOn('trim') || svcOn('door') || svcOn('window') || svcOn('ext_trim') || svcOn('ext_door') || svcOn('ext_window')
    if (c === 'exterior') return svcOn('ext_wall') || state.services.some(function (s) { return !s.builtin && s.enabled && s.paint === 'exterior' })
    return true
  }
  var EXTRA_SVC = { wall: 'interior_wall', ceiling: 'ceiling', trim: 'trim', door: 'door', window: 'window', ext_wall: 'ext_wall', ext_trim: 'ext_trim', ext_door: 'ext_door', ext_window: 'ext_window' }

  // ---------- account + sync (Supabase) ----------
  function settingsBlob() {
    return { org: state.org, rates: state.rates, products: state.products, services: state.services, profile: state.profile, onboarded: state.onboarded }
  }
  function scheduleSync() {
    if (!sb || !cloudUser) return
    clearTimeout(syncTimer)
    syncTimer = setTimeout(function () { syncNow() }, 1200)
  }
  async function syncNow() {
    if (!sb || !cloudUser) return
    await pushSettings(); await flushQuotes()
    var el = $('#syncState'); if (el) el.textContent = syncText()
  }
  function syncText() {
    if (!cloudUser) return ''
    return syncMsg || (state.syncDirty || state.pendingQ.length ? 'Saving to your account…' : 'All saved to your account.')
  }
  async function pushSettings() {
    var blob = JSON.stringify(settingsBlob())
    if (blob === lastPushed && !state.syncDirty) return
    try {
      var r = await sb.from('painters').upsert({ user_id: cloudUser.id, data: JSON.parse(blob), updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      if (r.error) throw r.error
      lastPushed = blob; state.syncDirty = false; syncMsg = ''
    } catch (e) { state.syncDirty = true; syncMsg = 'Could not reach your account - your changes are saved on this device and will sync later.' }
    localSave()
  }
  function queueQuote(id, op) {
    state.pendingQ = state.pendingQ.filter(function (x) { return x.id !== id })
    state.pendingQ.push({ id: id, op: op })
    localSave(); scheduleSync()
  }
  async function flushQuotes() {
    var todo = state.pendingQ.slice()
    for (var i = 0; i < todo.length; i++) {
      var it = todo[i], r
      try {
        if (it.op === 'delete') {
          r = await sb.from('quotes').delete().eq('id', it.id).eq('user_id', cloudUser.id)
        } else {
          var rec = state.quotes.filter(function (q) { return q.draft.id === it.id })[0]
          if (!rec) { state.pendingQ = state.pendingQ.filter(function (x) { return x !== it && x.id !== it.id }); continue }
          r = await sb.from('quotes').upsert({ id: it.id, user_id: cloudUser.id, number: rec.number, customer_name: rec.customer && rec.customer.name || '', total: rec.total, quote_date: rec.date, draft: rec.draft, updated_at: new Date().toISOString() }, { onConflict: 'user_id,id' })
        }
        if (r.error) throw r.error
        state.pendingQ = state.pendingQ.filter(function (x) { return x.id !== it.id })
      } catch (e) { syncMsg = 'Could not reach your account - your changes are saved on this device and will sync later.'; break }
    }
    if (!state.pendingQ.length && !state.syncDirty) syncMsg = ''
    localSave()
  }
  function applySettings(d) {
    d = d || {}
    if (d.org) state.org = Object.assign(defaults().org, d.org)
    if (d.rates) state.rates = Object.assign({}, P.DEFAULT_RATES, d.rates)
    if (Array.isArray(d.products) && d.products.length) state.products = d.products
    if (Array.isArray(d.services)) state.services = d.services
    if (d.profile) state.profile = d.profile
    state.onboarded = d.onboarded !== false
    normalise()
  }
  async function afterSignIn(user) {
    cloudUser = user
    if (state.owner && state.owner !== user.id) { state = defaults(); normalise() } // someone else's data on this device
    var wasMine = state.owner === user.id
    var s
    try { s = await sb.from('painters').select('data').eq('user_id', user.id) } catch (e) { s = { error: e } }
    if (s.error) { syncMsg = 'Could not reach your account - working from this device.'; state.owner = user.id; localSave(); goAfterAuth(); return }
    var row = s.data && s.data[0]
    state.owner = user.id
    if (row && !(wasMine && state.syncDirty)) {
      if (state.pendingQ.length) await flushQuotes()
      applySettings(row.data)
      lastPushed = JSON.stringify(settingsBlob())
      var q
      try { q = await sb.from('quotes').select('number,customer_name,total,quote_date,draft,updated_at').eq('user_id', user.id).order('updated_at', { ascending: true }) } catch (e) { q = { error: e } }
      if (!q.error && q.data) {
        var pendingIds = state.pendingQ.map(function (x) { return x.id })
        var local = state.quotes.filter(function (x) { return pendingIds.indexOf(x.draft.id) >= 0 })
        state.quotes = q.data.map(function (r) { return { number: r.number, date: r.quote_date, customer: (r.draft && r.draft.customer) || { name: r.customer_name }, total: Number(r.total), draft: r.draft } })
        local.forEach(function (l) { var i = state.quotes.findIndex(function (x) { return x.draft.id === l.draft.id }); if (i >= 0) state.quotes[i] = l; else state.quotes.push(l) })
      }
    } else if (state.onboarded) {
      // first sign-in with data already on this device (or unsynced changes): this device's data goes up
      state.syncDirty = true
      state.quotes.forEach(function (x) { if (!state.pendingQ.some(function (p) { return p.id === x.draft.id })) state.pendingQ.push({ id: x.draft.id, op: 'upsert' }) })
    }
    localSave()
    await syncNow()
    goAfterAuth()
  }
  function goAfterAuth() {
    if (BARE_TABS.indexOf(tab) >= 0 && tab !== 'recover') { tab = state.onboarded ? 'quote' : 'onboard'; obStep = 1 }
    render()
  }
  function authError(e) {
    var m = (e && e.message) || 'Something went wrong. Try again.'
    if (/Invalid login/i.test(m)) return 'That email or password is not right.'
    if (/already registered|already been registered/i.test(m)) return 'There is already an account with that email. Try logging in.'
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your connection and try again.'
    return m
  }
  function redirectUrl() { return location.origin + location.pathname }

  // ---------- demo notice + install help ----------
  function demoNotice() {
    return '<div class="card"><h2>About this demo</h2><div class="note" style="line-height:1.5">' +
      '<p style="margin:0 0 8px"><b>PaintQuote is a demo.</b> It is an early trial version, provided as is. It may contain mistakes, change without notice, or be switched off, and saved data could be lost. Keep your own copy of anything important.</p>' +
      '<p style="margin:0 0 8px"><b>Estimates only.</b> Starting prices are ballpark figures, not market rates or advice. Sizes taken from photos or aerial roof data are estimates and can be wrong. Always check measurements and prices yourself before you give a customer a quote.</p>' +
      '<p style="margin:0 0 8px"><b>You are responsible for your quotes and your work.</b> A quote made here is not a contract and is not legal, tax, licensing or insurance advice. You must make sure you hold the right licence (for example a QBCC licence in Queensland where one is required), insurance and safety practices, and that your quotes meet GST, Australian Consumer Law and any lead-paint or other rules that apply to the job.</p>' +
      '<p style="margin:0 0 8px"><b>Liability.</b> To the extent the law allows, PaintQuote and its creator are not liable for any loss or damage from using the app or relying on its figures. Nothing here limits rights you have under the Australian Consumer Law that cannot be excluded.</p>' +
      '<p style="margin:0"><b>Your information.</b> If you create an account, your email, prices, quotes and the customer details you type in are stored with our database provider (Supabase). Photos you measure are sent to an AI service (Anthropic) to be analysed and are not saved in your account. Job addresses you look up are sent to Google to find the roof. You are responsible for having the right to enter your customers’ details. We do not sell your information.</p>' +
      '</div></div>'
  }
  function installHelp() {
    return '<div class="card"><h2>Add it to your home screen</h2><div class="note" style="line-height:1.5">' +
      '<p style="margin:0 0 6px"><b>iPhone (Safari):</b> open this page in Safari, tap the Share button (the square with an arrow), scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</p>' +
      '<p style="margin:0"><b>Android (Chrome):</b> tap the ⋮ menu, then <b>Add to Home screen</b> (or <b>Install app</b>), then <b>Add</b>.</p>' +
      '</div></div>'
  }

  function viewWelcome() {
    return '<div class="card"><h2>Welcome to PaintQuote</h2><p class="note" style="margin:0 0 12px">Quote painting jobs in minutes. Create a free account to keep your prices and quotes safe and on every device.</p>' +
      '<div class="row"><button class="btn" data-act="auth-signup">Create account</button><button class="btn sec" data-act="auth-login">Log in</button></div>' +
      '<p class="note" style="margin:14px 0 0"><button class="link" data-act="skipauth">Try it without an account</button><br>Saved on this device only. You can create an account later and keep what you’ve done.</p></div>' + installHelp() + demoNotice()
  }
  function viewAuth() {
    var m = authMode, h = '<div class="card"><h2>' + (m === 'signup' ? 'Create your account' : m === 'forgot' ? 'Reset your password' : 'Log in') + '</h2><form id="authForm" autocomplete="on">'
    h += '<div class="row"><div><label>Email</label><input id="authEmail" type="email" inputmode="email" autocomplete="email" required></div></div>'
    if (m !== 'forgot') h += '<div class="row" style="margin-top:8px"><div><label>Password' + (m === 'signup' ? ' (at least 8 characters)' : '') + '</label><input id="authPw" type="password" autocomplete="' + (m === 'signup' ? 'new-password' : 'current-password') + '" required></div></div>'
    if (m === 'signup') h += '<label class="note" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input id="authAgree" type="checkbox" style="width:auto;margin-top:3px"><span>I understand PaintQuote is a demo, its figures are estimates I must check, and I am responsible for my own quotes and work.</span></label>'
    h += '<div id="authMsg" class="note" style="margin:10px 0">' + esc(authMsg) + '</div>'
    h += '<button class="btn" type="submit"' + (authBusy ? ' disabled' : '') + '>' + (m === 'signup' ? 'Create account' : m === 'forgot' ? 'Send reset link' : 'Log in') + '</button></form>'
    h += '<p class="note" style="margin:14px 0 0">'
    if (m === 'login') h += '<button class="link" data-act="auth-signup">Create an account</button> &middot; <button class="link" data-act="auth-forgot">Forgot password?</button>'
    else h += '<button class="link" data-act="auth-login">Back to log in</button>'
    h += '</p><p class="note" style="margin:8px 0 0"><button class="link" data-act="authback">' + (state.onboarded ? 'Cancel' : 'Back') + '</button></p></div>'
    return h
  }
  function viewRecover() {
    return '<div class="card"><h2>Choose a new password</h2><form id="recoverForm"><div class="row"><div><label>New password (at least 8 characters)</label><input id="newPw" type="password" autocomplete="new-password" required></div></div><div id="authMsg" class="note" style="margin:10px 0">' + esc(authMsg) + '</div><button class="btn" type="submit">Save password</button></form></div>'
  }
  async function submitAuth() {
    var email = ($('#authEmail').value || '').trim(), pw = $('#authPw') ? $('#authPw').value : '', msg = $('#authMsg')
    if (!sb) { msg.textContent = 'Accounts are not switched on for this copy of the app.'; return }
    if (authMode !== 'forgot' && authMode === 'signup' && pw.length < 8) { msg.textContent = 'Use at least 8 characters for the password.'; return }
    if (authMode === 'signup' && !($('#authAgree') && $('#authAgree').checked)) { msg.textContent = 'Please tick the box to confirm you understand this is a demo.'; return }
    authBusy = true; msg.textContent = 'One moment…'
    try {
      var r
      if (authMode === 'signup') {
        r = await sb.auth.signUp({ email: email, password: pw, options: { emailRedirectTo: redirectUrl() } })
        if (r.error) throw r.error
        if (!r.data.session) { authMode = 'login'; authMsg = 'Account created. Check your email for a confirmation link, then log in.'; authBusy = false; render(); return }
      } else if (authMode === 'forgot') {
        r = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() })
        if (r.error) throw r.error
        authMode = 'login'; authMsg = 'If there is an account for that email, a reset link is on its way.'; authBusy = false; render(); return
      } else {
        r = await sb.auth.signInWithPassword({ email: email, password: pw })
        if (r.error) throw r.error
      }
      authBusy = false // the auth listener takes it from here
    } catch (e) { authBusy = false; authMsg = authError(e); var m2 = $('#authMsg'); if (m2) m2.textContent = authMsg; var b = $('#authForm button[type=submit]'); if (b) b.disabled = false }
  }
  async function submitRecover() {
    var pw = $('#newPw').value, msg = $('#authMsg')
    if (pw.length < 8) { msg.textContent = 'Use at least 8 characters.'; return }
    var r = await sb.auth.updateUser({ password: pw })
    if (r.error) { msg.textContent = authError(r.error); return }
    authMsg = ''; tab = state.onboarded ? 'quote' : 'onboard'; toast('Password changed'); render()
  }
  async function signOut() {
    if (!confirm('Log out? Your prices and quotes stay safe in your account.')) return
    try { await syncNow() } catch (e) {}
    clearTimeout(syncTimer)
    try { await sb.auth.signOut() } catch (e) {}
    cloudUser = null; lastPushed = ''; syncMsg = ''
    state = defaults(); normalise(); localSave(); tab = 'welcome'; render()
  }
  function accountCard() {
    var h = '<div class="card"><h2>Account</h2>'
    if (!sb) return h + '<p class="note" style="margin:0">Accounts are not switched on for this copy of the app. Your data is saved on this device only.</p></div>'
    if (cloudUser) {
      return h + '<p style="margin:0 0 4px">Logged in as <b>' + esc(cloudUser.email || '') + '</b></p><p class="note" id="syncState" style="margin:0 0 10px">' + esc(syncText()) + '</p><button class="btn sec" data-act="signout">Log out</button></div>'
    }
    return h + '<p class="note" style="margin:0 0 10px">Your prices and quotes are saved on this device only. Create a free account to keep them safe and use them on your phone and computer &mdash; what you’ve done so far comes with you.</p><div class="row"><button class="btn" data-act="auth-signup">Create account</button><button class="btn sec" data-act="auth-login">Log in</button></div></div>'
  }

  // ---------- calling the photo / roof functions ----------
  async function fnHeaders() {
    var h = { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_KEY }
    var code = getCode()
    if (code) h['x-access-code'] = code
    if (sb && cloudUser) { try { var s = await sb.auth.getSession(); if (s.data.session) h.Authorization = 'Bearer ' + s.data.session.access_token } catch (e) {} }
    return h
  }
  function canCallFns() { return !!(cloudUser || getCode()) }
  async function callFn(name, payload) {
    var res = await fetch(cfg.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name, { method: 'POST', headers: await fnHeaders(), body: JSON.stringify(payload) })
    var b = {}; try { b = await res.json() } catch (e) {}
    if (!res.ok) throw new Error(b.error || 'That did not work (' + res.status + ').')
    return b
  }
  function friendly(e) { return /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Could not reach the server. Check your connection and try again.' : e.message }

  // ---------- calculation ----------
  function calc(d) {
    d = d || state.draft
    var paint = P.resolvePaint(state.products, d.selection)
    return P.calculateQuote({ rates: state.rates, organization: state.org, job: d.job, paint: paint, services: state.services, enabled: enabledMap() })
  }

  // ---------- render ----------
  function render() {
    $('#nav').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab) })
    var app = $('#app')
    var y = window.scrollY
    $('.top nav').style.display = BARE_TABS.indexOf(tab) >= 0 ? 'none' : ''
    if (tab === 'onboard') app.innerHTML = viewOnboard()
    else if (tab === 'loading') app.innerHTML = '<div class="card"><div class="empty">Loading&hellip;</div></div>'
    else if (tab === 'welcome') app.innerHTML = viewWelcome()
    else if (tab === 'auth') app.innerHTML = viewAuth()
    else if (tab === 'recover') app.innerHTML = viewRecover()
    else if (tab === 'quote') app.innerHTML = viewQuote()
    else if (tab === 'history') app.innerHTML = viewHistory()
    else if (tab === 'settings') app.innerHTML = viewSettings()
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
    h += '<div class="row" style="margin-bottom:12px"><div style="flex:2 1 220px"><label>Quick start: whole house</label><select id="houseType"><option value="">Choose a house type...</option>'
    houseOrder().forEach(function (t) { h += '<option value="' + t.id + '">' + esc(t.label) + '</option>' })
    h += '</select></div><div style="flex:0 0 auto"><button class="btn sec" data-act="addhouse">Add rooms</button></div></div>'
    h += '<div class="chips">'
    P.ROOM_PRESETS.forEach(function (p) { h += '<button class="chip" data-act="addroom" data-id="' + p.id + '">+ ' + esc(p.label) + '</button>' })
    h += '<button class="chip" data-act="addblank">+ Custom room</button></div>'
    h += '<p class="note" style="margin:8px 0 0">Tap a room to add it at a typical size, then change the sizes if you have measured it.</p>'
    h += '<div id="rooms">'
    if (!j.rooms.length) h += '<div class="empty">No rooms yet.</div>'
    j.rooms.forEach(function (r, i) { h += roomCard(r, i) })
    h += '</div></div>'

    h += photoCard()

    // other work: extra surfaces + the painter's own services
    var opts = ''
    P.EXTRA_KINDS.forEach(function (k) { if (svcOn(EXTRA_SVC[k.id])) opts += '<option value="x:' + k.id + '">' + esc(k.label) + '</option>' })
    state.services.forEach(function (sv) { if (!sv.builtin && sv.enabled) opts += '<option value="s:' + sv.id + '">' + esc(sv.name) + ' (' + unitLabel(sv.unit) + ')</option>' })
    h += '<div class="card"><h2>Other work</h2><p class="note" style="margin:0 0 8px">Feature walls, extra ceilings, fences, repairs &mdash; anything not in a room above.</p>'
    h += '<div class="row"><div style="flex:2 1 220px"><label>Add</label><select id="extraKind">' + opts + '</select></div><div style="flex:0 0 auto"><button class="btn sec" data-act="addextra">Add</button></div></div>'
    if (cfg.SUPABASE_URL && roofOn()) h += '<div style="margin:10px 0"><button class="btn sec" data-act="roof">Measure roof from the job address</button><div id="roofMsg" class="note" style="margin-top:6px"></div></div>'
    j.extras.forEach(function (x, i) { h += extraCard(x, i) })
    j.custom.forEach(function (c, i) { h += customCard(c, i) })
    h += '</div>'

    // exterior
    var extOn = svcOn('ext_wall') || svcOn('ext_trim') || svcOn('ext_door') || svcOn('ext_window')
    if (extOn) h += '<div class="card"><h2>Exterior</h2>'
    if (!extOn) {} else if (!j.exterior) {
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
      if (e.source === 'photo') h += '<div class="sum"><span class="tag photo">from photo</span> ' + esc(e.note || '') + '</div>'
      else if (e.source !== 'measured') h += '<div class="sum"><span class="tag">estimated size</span></div>'
      h += '<div style="margin-top:8px"><button class="link red" data-act="rmext">Remove exterior</button></div>'
    }
    if (extOn) h += '</div>'

    // job options
    h += '<div class="card"><h2>Job options</h2><div class="row">'
    h += '<div><label>Finish coats</label><select data-f="job.coats" data-num="1">'
    ;[1, 2, 3].forEach(function (c) { h += '<option value="' + c + '"' + (Number(j.coats) === c ? ' selected' : '') + '>' + c + '</option>' })
    h += '</select></div><div style="flex:2 1 200px"><label>Surface condition</label><select data-f="job.condition">'
    P.CONDITIONS.forEach(function (c) { h += '<option value="' + c.id + '"' + (j.condition === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>' })
    h += '</select></div></div>'
    h += '<div style="margin-top:10px"><label class="chk"><input type="checkbox" data-f="job.primer" data-bool="1"' + (j.primer ? ' checked' : '') + '> Add a primer / sealer coat</label></div>'
    if (showHeritage(j)) h += '<div style="margin-top:8px"><label class="chk"><input type="checkbox" data-f="job.heritage" data-bool="1"' + (j.heritage ? ' checked' : '') + '> Older timber home (VJ boards, ornate trim, high ceilings)</label></div>'
    if (j.heritage && showHeritage(j)) h += '<div class="hint" style="margin-top:8px">Built before 1970? The paint may contain lead &mdash; test before sanding or scraping. Add <b>Lead paint test</b> or <b>Lead-safe preparation</b> under Other work (switch them on under Prices).</div>'
    h += '<h3>Paint</h3>'
    P.PAINT_CATEGORIES.forEach(function (c) {
      var list = state.products.filter(function (p) { return p.category === c.id })
      if (!list.length || !catVisible(c.id)) return
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
    h += '<div class="card"><h2>Send to customer</h2><div id="sendbox">' + sendBox() + '</div></div>'
    return h
  }

  function photoCard() {
    var modes = ''
    if (svcOn('interior_wall')) modes += '<option value="room">A whole room</option><option value="wall">One wall / feature wall</option>'
    if (svcOn('ext_wall')) modes += '<option value="exterior">House exterior</option>'
    if (!modes) return ''
    var cfg = window.PQ_CONFIG || {}
    var h = '<div class="card"><h2>Add from a photo</h2>'
    if (!cfg.SUPABASE_URL) return h + '<div class="note">Photo measuring isn\'t switched on yet.</div></div>'
    h += '<p class="note" style="margin:0 0 8px">Take 1&ndash;4 photos. For a room, stand in a corner so both walls and a door are in view. The size is an estimate &mdash; check it before sending the quote.</p>'
    h += '<div class="row"><div><label>What is it?</label><select id="photoMode">' + modes + '</select></div>' + (cloudUser ? '' : '<div><label>Access code</label><input id="photoCode" type="password" autocomplete="off" value="' + esc(getCode()) + '"></div>') + '</div>'
    h += '<div style="margin-top:8px"><input id="photoFiles" type="file" accept="image/*" multiple></div>'
    h += '<div style="margin-top:10px"><button class="btn" data-act="analyse">Measure from photo</button></div><div id="photoMsg" class="note" style="margin-top:8px"></div></div>'
    return h
  }
  function getCode() { try { return localStorage.getItem('pq.code') || '' } catch (e) { return '' } }

  // Shrink a phone photo (often 4000+ px) before upload, honouring camera rotation.
  function downscale(file, maxSide, quality) {
    maxSide = maxSide || 1280; quality = quality || 0.82
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
      var c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
      return { mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', quality).split(',')[1] }
    })
  }
  function applyEstimate(mode, est) {
    var j = state.draft.job, note = (est.confidence ? est.confidence + ' confidence' : '') + (est.reasoning ? ' \u2014 ' + est.reasoning : '')
    var n = function (v) { return Math.round((Number(v) || 0) * 10) / 10 }
    if (mode === 'room') {
      var r = P.emptyRoom('Room (photo)')
      r.length = n(est.length_m); r.width = n(est.width_m); r.height = n(est.height_m) || 2.4
      r.doors = Math.max(0, Math.floor(est.doors || 0)); r.windows = Math.max(0, Math.floor(est.windows || 0))
      r.source = 'photo'; r.note = note; j.rooms.push(r)
    } else if (mode === 'wall') {
      var x = P.emptyExtra('wall'); x.a = n(est.wall_width_m); x.b = n(est.wall_height_m); x.source = 'photo'; x.note = note; j.extras.push(x)
    } else {
      var e = P.emptyExterior()
      e.wallArea = Math.round(Number(est.wall_area_m2) || 0); e.trimLength = Math.round(Number(est.trim_length_m) || 0)
      e.storeys = [1, 2, 3].indexOf(Number(est.storeys)) >= 0 ? Number(est.storeys) : 1
      e.doors = Math.max(0, Math.floor(est.doors || 0)); e.windows = Math.max(0, Math.floor(est.windows || 0))
      e.source = 'photo'; e.note = note; j.exterior = e
    }
  }
  function analysePhotos() {
    var msg = $('#photoMsg'), btn = $('[data-act="analyse"]')
    var files = Array.prototype.slice.call($('#photoFiles').files || [], 0, 4)
    var mode = $('#photoMode').value
    var codeEl = $('#photoCode'); if (codeEl && codeEl.value.trim()) { try { localStorage.setItem('pq.code', codeEl.value.trim()) } catch (e) {} }
    if (location.protocol === 'file:') { msg.textContent = 'Photo measuring only works on the hosted site, not a downloaded file.'; return }
    if (!files.length) { msg.textContent = 'Choose or take a photo first.'; return }
    if (!canCallFns()) { msg.textContent = 'Log in (or enter the access code) to measure from photos.'; return }
    btn.disabled = true; msg.textContent = 'Measuring… this takes a few seconds.'
    Promise.all(files.map(function (f) { return downscale(f) })).then(function (images) {
      return callFn('analyse-photo', { images: images, mode: mode, ceilingHeight: Number(state.draft.height) || 0 })
    }).then(function (b) {
      applyEstimate(mode, b.estimate); save(); render()
      var m = $('#photoMsg'); if (m) m.textContent = 'Added. Check the sizes below and adjust if needed.'
      window.scrollTo(0, document.body.scrollHeight * 0.2)
    }).catch(function (e) { btn.disabled = false; msg.textContent = friendly(e) })
  }

  // ---------- roof from the job address (Google Solar, via the server) ----------
  function roofOn() { return state.services.some(function (x) { return x.id === 'roof' && x.enabled }) }
  function measureRoof() {
    var msg = $('#roofMsg'), btn = $('[data-act="roof"]'), addr = (state.draft.customer.address || '').trim()
    if (location.protocol === 'file:') { msg.textContent = 'Roof measuring only works on the hosted site.'; return }
    if (addr.length < 6) { msg.textContent = 'Enter the job address at the top first (street, suburb, state).'; return }
    if (!canCallFns()) { msg.textContent = 'Log in (or enter the access code in Settings) to measure roofs.'; return }
    btn.disabled = true; msg.textContent = 'Looking up the roof…'
    callFn('roof-measure', { address: addr }).then(function (b) {
      applyRoof(b.roof); save(); render()
      var m = $('#roofMsg'); if (m) m.textContent = 'Roof added. This is an estimate from aerial data — check it before you quote.'
    }).catch(function (e) { btn.disabled = false; msg.textContent = friendly(e) })
  }
  function applyRoof(r) {
    var j = state.draft.job, c = j.custom.filter(function (x) { return x.service_id === 'roof' })[0]
    if (!c) { c = { service_id: 'roof', qty: '' }; j.custom.push(c) }
    c.qty = Math.round(Number(r.roof_area_m2) || 0); c.source = 'map'
    c.note = 'Aerial data' + (r.imagery_date ? ' (' + r.imagery_date + ')' : '') + (r.segments ? ', ' + r.segments + ' roof planes' : '') + (r.pitch_deg ? ', average pitch ' + r.pitch_deg + '°' : '') + (r.approximate ? '. The address match was approximate' : '') + (r.address ? '. Found: ' + r.address : '')
  }

  function logoBox() {
    var o = state.org
    var h = '<div style="margin-top:12px"><label>Logo (shown on customer quotes)</label>'
    if (o.logo) h += '<div style="margin:6px 0"><img src="' + o.logo + '" alt="Logo" style="max-height:56px;max-width:180px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff"></div><button class="link red" data-act="rmlogo">Remove logo</button>'
    else h += '<input id="logoFile" type="file" accept="image/png,image/jpeg,image/webp">'
    return h + '</div>'
  }
  function readLogo(file) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var k = Math.min(1, 360 / Math.max(bmp.width, bmp.height))
      var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k))
      var ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, c.width, c.height)
      var png = file.type === 'image/png' || file.type === 'image/webp' // keep transparency
      if (!png) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height) }
      state.org.logo = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9)
      state.org.logo_type = png ? 'PNG' : 'JPEG'; state.org.logo_w = c.width; state.org.logo_h = c.height
    })
  }

  // ---------- customer quote as a real PDF file ----------
  function peekNumber(d) {
    var ex = state.quotes.filter(function (s) { return s.draft.id === d.id })[0]
    return ex ? ex.number : state.org.quote_prefix + state.org.next_number
  }
  function makePdf() {
    var jsPDF = window.jspdf && window.jspdf.jsPDF
    if (!jsPDF) throw new Error('PDF tools did not load - check your connection and reload.')
    var d = state.draft, q = calc(d), o = state.org
    var scope = P.describeScope({ job: d.job, quantities: q.quantities })
    var number = peekNumber(d)
    var doc = new jsPDF({ unit: 'mm', format: 'a4' })
    var L = 16, R = 194, y = 18
    var tx = L
    if (o.logo) {
      var h = Math.min(18, 45 * o.logo_h / o.logo_w), w = h * o.logo_w / o.logo_h
      doc.addImage(o.logo, o.logo_type || 'PNG', L, y - 4, w, h, undefined, 'FAST')
      y += h + 2
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(31, 58, 95)
    doc.text(o.name || 'Painting quote', tx, y + 4)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100)
    var contact = [o.abn && 'ABN ' + o.abn, o.licence && 'QBCC Lic. ' + o.licence, o.phone, o.email].filter(Boolean).join('   |   ')
    if (contact) doc.text(contact, tx, y + 10)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(31, 58, 95); doc.text('QUOTE', R, 22, { align: 'right' })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100)
    doc.text([number, today(), 'Valid ' + o.valid_days + ' days'], R, 28, { align: 'right' })
    y += 16
    doc.setDrawColor(31, 58, 95); doc.setLineWidth(0.8); doc.line(L, y, R, y); y += 9
    doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Prepared for', L, y); y += 5
    doc.setFont('helvetica', 'normal')
    var cust = [d.customer.name || '-', d.customer.address].filter(Boolean)
    cust.forEach(function (l) { doc.text(l, L, y); y += 5 })
    y += 5
    var need = function (n) { if (y + n > 275) { doc.addPage(); y = 20 } }
    doc.setFont('helvetica', 'bold'); doc.text('Scope of work', L, y); y += 6
    doc.setFont('helvetica', 'normal')
    scope.forEach(function (line) {
      doc.splitTextToSize(line, R - L - 6).forEach(function (part, i) { need(6); if (i === 0) doc.text('-', L, y); doc.text(part, L + 5, y); y += 5 })
      y += 1
    })
    if (d.notes) {
      y += 3; need(14); doc.setFont('helvetica', 'bold'); doc.text('Notes', L, y); y += 5; doc.setFont('helvetica', 'normal')
      doc.splitTextToSize(d.notes, R - L).forEach(function (part) { need(6); doc.text(part, L, y); y += 5 })
    }
    y += 8; need(34)
    var rowAt = function (label, val, bold) { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10); doc.text(label, 120, y); doc.text(val, R, y, { align: 'right' }); y += bold ? 7 : 6 }
    rowAt('Total (ex GST)', money(q.preGst)); rowAt('GST', money(q.gst))
    doc.setLineWidth(0.4); doc.setDrawColor(20); doc.line(120, y - 3, R, y - 3); y += 1.5
    rowAt('Total', money(q.total), true)
    y += 8; need(16)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100)
    var fine = (P.hasEstimates(d.job) ? 'Some room sizes are estimates. The price will be confirmed after final measurement on site. ' : '') + 'Paint, materials and labour are included. This quote is valid for ' + o.valid_days + ' days.'
    doc.splitTextToSize(fine, R - L).forEach(function (part) { doc.text(part, L, y); y += 4 })
    var safe = function (t) { return String(t || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') }
    var name = 'Quote-' + safe(number) + (d.customer.name ? '-' + safe(d.customer.name) : '') + '.pdf'
    return { blob: doc.output('blob'), name: name, number: number, total: q.total }
  }
  function ensureQuote() {
    var q = calc()
    if (!q.total) { alert('Add at least one room or surface first.'); return false }
    saveQuote(true); return true
  }
  function downloadPdf() {
    if (!ensureQuote()) return
    try {
      var r = makePdf(), url = URL.createObjectURL(r.blob), a = document.createElement('a')
      a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
      toast('PDF saved: ' + r.name)
    } catch (e) { alert(e.message) }
  }
  function sharePdf() {
    if (!ensureQuote()) return
    var r
    try { r = makePdf() } catch (e) { alert(e.message); return }
    var file = new File([r.blob], r.name, { type: 'application/pdf' })
    var who = state.draft.customer.name ? state.draft.customer.name.split(' ')[0] : 'there'
    var data = { files: [file], title: 'Quote ' + r.number, text: 'Hi ' + who + ', here is your painting quote from ' + state.org.name + '.' }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share(data).catch(function (e) { if (e && e.name !== 'AbortError') downloadPdf() })
    } else { downloadPdf() }
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
    ;[['ceiling', 'Ceiling', 'ceiling'], ['trim', 'Skirting', 'trim'], ['paintDoors', 'Doors', 'door'], ['paintWindows', 'Window frames', 'window']].filter(function (c) { return svcOn(c[2]) }).forEach(function (c) {
      h += '<label class="chk"><input type="checkbox" data-f="job.rooms.' + i + '.' + c[0] + '" data-bool="1"' + (r[c[0]] ? ' checked' : '') + '> ' + c[1] + '</label>'
    })
    h += '</div><div class="sum" id="rs' + i + '">' + roomSummary(m) + '</div>' + (r.note && r.source === 'photo' ? '<div class="sum">Photo estimate: ' + esc(r.note) + '</div>' : '') + '</div>'
    return h
  }
  function roomSummary(m) {
    var p = []
    if (svcOn('interior_wall')) p.push(Math.round(m.wallArea) + ' sqm walls')
    if (m.ceilingArea && svcOn('ceiling')) p.push(Math.round(m.ceilingArea) + ' sqm ceiling')
    if (m.trimLength && svcOn('trim')) p.push(Math.round(m.trimLength) + ' m skirting')
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
    h += '</div>' + (x.note && x.source === 'photo' ? '<div class="sum">Photo estimate: ' + esc(x.note) + '</div>' : '') + '</div>'
    return h
  }

  function customCard(c, i) {
    var sv = state.services.filter(function (x) { return x.id === c.service_id })[0]
    if (!sv) return ''
    var h = '<div class="room"><div class="head"><b style="flex:1">' + esc(sv.name) + '</b>' + (c.source === 'map' ? '<span class="tag photo">from aerial data</span>' : '') + '<button class="link red" data-act="rmcustom" data-i="' + i + '">&times;</button></div>'
    if (sv.unit === 'fixed') return h + '<div class="note">Fixed price ' + money(sv.rate) + '</div></div>'
    return h + '<div class="row"><div><label>' + esc(unitShort(sv.unit)) + '</label>' + num(sv.unit === 'each' ? 1 : 'any') + 'data-f="job.custom.' + i + '.qty" data-clr="1" value="' + esc(c.qty) + '"></div></div>' + (c.note && c.source === 'map' ? '<div class="sum">' + esc(c.note) + '</div>' : '') + '</div>'
  }

  function sendBox() {
    var d = state.draft, q = calc(d), c = d.customer
    var who = c.name ? c.name.split(' ')[0] : 'there'
    var body = 'Hi ' + who + ', here is your painting quote from ' + state.org.name + ': ' + money(q.total) + ' including GST. Happy to answer any questions.'
    var h = '<div class="row"><button class="btn acc" data-act="share">Share PDF</button><button class="btn sec" data-act="download">Download PDF</button></div>'
    h += '<p class="note" style="margin:10px 0 6px">The PDF shows the scope and total only &mdash; never your labour, materials or margin.</p><div class="row" style="gap:14px">'
    if (c.email) h += '<a class="link" href="mailto:' + esc(c.email) + '?subject=' + encodeURIComponent('Painting quote from ' + state.org.name) + '&body=' + encodeURIComponent(body) + '">Email message</a>'
    if (c.phone) h += '<a class="link" href="sms:' + esc(c.phone) + '?&body=' + encodeURIComponent(body) + '">Text message</a>'
    h += '<button class="link" data-act="pdf">Print</button></div>'
    if (!c.email && !c.phone) h += '<p class="note">Add the customer\'s email or phone above to get email / text shortcuts.</p>'
    return h
  }

  function breakdown() {
    var q = calc(), d = state.draft
    var h = '<h2>Price breakdown <span class="note">(only you see this)</span></h2>'
    if (q.total === 0) return h + '<div class="empty">Add a room to see the price.</div>'
    h += '<table>'
    q.labourLines.forEach(function (l) { h += '<tr><td>' + esc(l.label) + '</td><td class="r">' + money(l.amount) + '</td></tr>' })
    q.customLines.forEach(function (l) { h += '<tr><td>' + esc(l.label) + ' <span class="note">' + l.qty + ' ' + esc(l.unit) + '</span></td><td class="r">' + money(l.amount) + '</td></tr>' })
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
      '<button class="btn sec" data-act="clear">New</button><button class="btn sec" data-act="save">Save</button><button class="btn acc" data-act="share">Send quote</button></div>'
  }
  function removeBar() { var b = $('#bar'); if (b) b.remove() }

  function updateLive() {
    var b = $('#breakdown'); if (b) b.innerHTML = breakdown()
    var sb = $('#sendbox'); if (sb) sb.innerHTML = sendBox()
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
    ['heritage_labour_factor', 'Older timber home: labour factor'], ['heritage_paint_factor', 'Older timber home: extra paint'],
    ['min_charge', 'Minimum labour charge ($)'], ['consumables_pct', 'Consumables (fraction of paint cost)']
  ]
  function viewSettings() {
    var h = accountCard()
    h += '<div class="card"><h2>Your business</h2><div class="row"><div style="flex:2 1 200px"><label>Business name</label><input data-f="org.name" value="' + esc(state.org.name) + '"></div><div><label>ABN</label><input data-f="org.abn" value="' + esc(state.org.abn) + '"></div></div><div class="row" style="margin-top:8px"><div><label>QBCC licence no.</label><input data-f="org.licence" value="' + esc(state.org.licence) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Phone</label><input data-f="org.phone" value="' + esc(state.org.phone) + '"></div><div><label>Email</label><input data-f="org.email" value="' + esc(state.org.email) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Margin (%)</label>' + num() + 'data-f="org.margin_rate" data-pct="1" value="' + Math.round(state.org.margin_rate * 1000) / 10 + '"></div><div><label>GST (%)</label>' + num() + 'data-f="org.gst_rate" data-pct="1" value="' + Math.round(state.org.gst_rate * 1000) / 10 + '"></div><div><label>Quote valid (days)</label>' + num(1) + 'data-f="org.valid_days" value="' + esc(state.org.valid_days) + '"></div></div>' + logoBox() + '</div>'

    h += '<div class="card"><h2>What you paint</h2><p class="note" style="margin:0 0 4px">Controls the house types listed first and whether the older-timber option shows on quotes. Tick services under Prices.</p>' + profileBox() + '</div>'
    h += '<div class="card"><h2>Quote numbering</h2><div class="row"><div><label>Prefix</label><input data-f="org.quote_prefix" value="' + esc(state.org.quote_prefix) + '"></div><div><label>Next number</label>' + num(1) + 'data-f="org.next_number" value="' + esc(state.org.next_number) + '"></div></div></div>'
    h += '<div class="card"><h2>Owner access code</h2><p class="note" style="margin:0 0 8px">Optional. Lets you use photo and roof measuring without limits (for trials). Painters with an account don\'t need this.</p><div class="row"><div><label>Access code</label><input type="password" autocomplete="off" id="settingsCode" value="' + esc(getCode()) + '"></div></div></div>'
    h += '<div class="card"><h2>Your data</h2><p class="note" style="margin:0 0 8px">' + (cloudUser ? 'Your quotes and prices are saved to your account.' : 'Quotes and prices are saved on this device only.') + '</p><button class="btn sec" data-act="reset">Reset everything to demo defaults</button></div>'
    h += installHelp() + demoNotice()
    return h
  }

  function viewPrices() {
    var h = '<div class="hint">These are ballpark starting prices. Change them to your own &mdash; every quote uses whatever is here. Business details and logo are under Settings.</div>'
    h += '<div class="card"><h2>My services</h2><p class="note" style="margin:0 0 8px">Tick what you offer and set your rate. Only ticked services appear when you quote.</p>'
    state.services.forEach(function (sv, i) {
      h += '<div class="room"><label class="chk" style="font-weight:600"><input type="checkbox" data-f="services.' + i + '.enabled" data-bool="1" data-rerender="1"' + (sv.enabled !== false ? ' checked' : '') + '> ' + esc(sv.name) + '</label>'
      if (sv.enabled !== false) h += svcForm(sv, i)
      h += '</div>'
    })
    h += '<button class="btn sec sm" style="margin-top:8px" data-act="addsvc">+ Add my own service</button></div>'
    h += '<div class="card"><h2>Job modifiers</h2>'
    RATE_LABELS.forEach(function (r) {
      if (r[1] === null) return
      if (!/primer|condition|storey|heritage|min_charge|consumables/.test(r[0])) return
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
    h += '</div>'
    return h
  }

  function svcForm(sv, i) {
    var h = ''
    if (sv.builtin) {
      h += '<div class="row" style="margin-top:8px;align-items:center"><div style="flex:2 1 150px" class="note">Your rate (' + esc(unitLabel(sv.unit)) + ', per coat)</div><div style="flex:0 0 110px">' + num() + 'data-f="rates.' + sv.rateKey + '" value="' + esc(state.rates[sv.rateKey]) + '"></div></div>'
      return h
    }
    h += '<div class="row" style="margin-top:8px"><div style="flex:2 1 160px"><label>Service name</label><input data-f="services.' + i + '.name" value="' + esc(sv.name) + '"></div>'
    h += '<div><label>Priced</label><select data-f="services.' + i + '.unit" data-rerender="1">'
    P.UNITS.forEach(function (u) { h += '<option value="' + u.id + '"' + (sv.unit === u.id ? ' selected' : '') + '>' + esc(u.label) + '</option>' })
    h += '</select></div><div><label>' + (sv.unit === 'fixed' ? 'Price ($)' : 'Your rate ($ ' + esc(unitLabel(sv.unit)) + ')') + '</label>' + num() + 'data-f="services.' + i + '.rate" value="' + esc(sv.rate) + '"></div></div>'
    h += '<div class="row" style="margin-top:8px"><div><label>Minimum charge ($)</label>' + num() + 'data-f="services.' + i + '.min_charge" value="' + esc(sv.min_charge) + '"></div>'
    if (sv.unit === 'sqm') {
      h += '<div><label>Uses paint</label><select data-f="services.' + i + '.paint" data-rerender="1"><option value="">No paint</option>'
      P.PAINT_CATEGORIES.forEach(function (c) { h += '<option value="' + c.id + '"' + (sv.paint === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>' })
      h += '</select></div>'
    }
    h += '</div>'
    if (sv.unit !== 'fixed' && sv.unit !== 'hour') h += '<div style="margin-top:8px"><label class="chk"><input type="checkbox" data-f="services.' + i + '.per_coat" data-bool="1"' + (sv.per_coat ? ' checked' : '') + '> Rate is per coat (multiplied by number of coats)</label></div>'
    h += '<div style="margin-top:6px"><button class="link red" data-act="rmsvc" data-i="' + i + '">Remove this service</button></div>'
    return h
  }

  function profileBox() {
    var p = state.profile, h = ''
    h += '<h3>Type of work</h3><div style="margin:6px 0"><label class="chk"><input type="checkbox" data-f="profile.interior" data-bool="1"' + (p.interior ? ' checked' : '') + '> Interior painting</label></div>'
    h += '<div style="margin:6px 0"><label class="chk"><input type="checkbox" data-f="profile.exterior" data-bool="1"' + (p.exterior ? ' checked' : '') + '> Exterior painting</label></div>'
    h += '<h3>The homes you mostly paint</h3>'
    ;[['qld', 'Queenslanders & older timber homes (VJ boards, verandahs, high ceilings)'], ['brick', 'Newer brick / low-set homes'], ['unit', 'Units & townhouses']].forEach(function (x) {
      h += '<div style="margin:6px 0"><label class="chk"><input type="checkbox" data-f="profile.homes.' + x[0] + '" data-bool="1"' + (p.homes[x[0]] ? ' checked' : '') + '> ' + esc(x[1]) + '</label></div>'
    })
    return h
  }

  function viewOnboard() {
    var h = '<div class="card"><div class="note">Step ' + obStep + ' of 4</div>'
    if (obStep === 1) {
      h += '<h2>Welcome &mdash; set up your business</h2><div class="row"><div style="flex:2 1 200px"><label>Business name</label><input data-f="org.name" value="' + esc(state.org.name) + '"></div></div>'
      h += '<div class="row" style="margin-top:8px"><div><label>Phone</label><input data-f="org.phone" value="' + esc(state.org.phone) + '"></div><div><label>Email</label><input data-f="org.email" value="' + esc(state.org.email) + '"></div></div>'
      h += '<div class="row" style="margin-top:8px"><div><label>QBCC licence no. (shown on quotes)</label><input data-f="org.licence" value="' + esc(state.org.licence) + '"></div></div>'
      h += '<div class="row" style="margin-top:8px"><div><label>Profit margin (%)</label>' + num() + 'data-f="org.margin_rate" data-pct="1" value="' + Math.round(state.org.margin_rate * 1000) / 10 + '"></div><div><label>GST (%)</label>' + num() + 'data-f="org.gst_rate" data-pct="1" value="' + Math.round(state.org.gst_rate * 1000) / 10 + '"></div></div>' + logoBox()
    } else if (obStep === 2) {
      h += '<h2>What do you mostly paint?</h2><p class="note">This sets up your starting services and house types. You can change anything on the next screens.</p>' + profileBox()
    } else if (obStep === 3) {
      h += '<h2>What services do you offer?</h2><p class="note">Tick everything you do. You can add your own at the bottom, and change this any time.</p>'
      ;[['interior', 'Interior'], ['exterior', 'Exterior'], ['qld', 'Queenslander & older homes'], ['other', 'Other work']].forEach(function (g) {
        h += '<h3>' + g[1] + '</h3>'
        state.services.forEach(function (sv, i) {
          if (sv.group !== g[0]) return
          h += '<div style="margin:6px 0"><label class="chk"><input type="checkbox" data-f="services.' + i + '.enabled" data-bool="1"' + (sv.enabled !== false ? ' checked' : '') + '> ' + esc(sv.name) + '</label></div>'
        })
      })
      h += '<button class="btn sec sm" style="margin-top:10px" data-act="addsvc">+ Add my own service</button>'
    } else {
      h += '<h2>Set your prices</h2><p class="note">Starting figures are typical Australian rates &mdash; change them to yours. Labour only; paint is priced separately.</p>'
      var any = false
      state.services.forEach(function (sv, i) {
        if (sv.enabled === false) return
        any = true
        h += '<div class="room"><b>' + esc(sv.name) + '</b>' + svcForm(sv, i) + '</div>'
      })
      if (!any) h += '<div class="empty">No services ticked. Go back and tick at least one.</div>'
    }
    h += '<div class="row" style="margin-top:14px">'
    if (obStep > 1) h += '<button class="btn sec" data-act="obback">Back</button>'
    h += obStep < 4 ? '<button class="btn" data-act="obnext">Next</button>' : '<button class="btn acc" data-act="obfinish">Start quoting</button>'
    return h + '</div></div>'
  }

  // ---------- events ----------
  function setPath(path, val) {
    var parts = path.split('.'), o = state
    for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]]
    o[parts[parts.length - 1]] = val
  }
  // typing in a size field means the painter has now confirmed it by hand
  function confirmSource(path) {
    var m = path.match(/^job\.(rooms|extras|custom)\.(\d+)\./)
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
    if (el.id === 'settingsCode') { try { localStorage.setItem('pq.code', el.value.trim()) } catch (x) {} return }
    if (el.dataset.sel) { state.draft.selection[el.dataset.sel] = el.value; save(); updateLive(); return }
    var f = el.dataset.f
    if (!f || el.type === 'radio') return
    var v = fieldVal(el)
    if (el.dataset.pct) v = (Number(el.value) || 0) / 100
    var path = /^(org|rates|products|services|profile)\./.test(f) ? f : 'draft.' + f
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
    if (el.id === 'logoFile' && el.files && el.files[0]) { readLogo(el.files[0]).then(function () { save(); render() }).catch(function () { alert('Could not read that image.') }); return }
    if (el.dataset.act === 'setdef') {
      var i = Number(el.dataset.i), cat = state.products[i].category
      state.products.forEach(function (p) { if (p.category === cat) p.is_default = false })
      state.products[i].is_default = true; save(); return
    }
    if (el.dataset.rerender) { var y2 = window.scrollY; save(); render(); window.scrollTo(0, y2); return }
    // selects & checkboxes re-render the quote so summaries/paint lists stay right
    if (tab === 'quote' && (el.dataset.f || el.dataset.sel) && (el.tagName === 'SELECT' || el.type === 'checkbox')) { setTimeout(render, 0) }
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
    else if (act === 'addhouse') {
      var tid = $('#houseType').value
      if (!tid) { alert('Choose a house type first.'); return }
      var tpl = P.HOUSE_TEMPLATES.filter(function (x) { return x.id === tid })[0]
      if (j.rooms.length && !confirm('Add these rooms to the ' + j.rooms.length + ' already on the quote?')) return
      P.roomsFromTemplate(tpl).forEach(function (r) { j.rooms.push(r) })
      d.height = tpl.height; if (tpl.heritage) j.heritage = true
    }
    else if (act === 'dup') { var c = JSON.parse(JSON.stringify(j.rooms[i])); c.name += ' (copy)'; j.rooms.splice(i + 1, 0, c) }
    else if (act === 'rmroom') j.rooms.splice(i, 1)
    else if (act === 'addextra') {
      var ev = $('#extraKind').value
      if (!ev) { alert('Switch on some services under Prices first.'); return }
      if (ev.indexOf('x:') === 0) j.extras.push(P.emptyExtra(ev.slice(2), Number(d.height) || 2.4))
      else { var sv0 = state.services.filter(function (x) { return x.id === ev.slice(2) })[0]; j.custom.push({ service_id: sv0.id, qty: sv0.unit === 'fixed' ? 1 : '' }) }
    }
    else if (act === 'rmcustom') j.custom.splice(i, 1)
    else if (act === 'addsvc') { state.services.push({ id: newId(), group: 'other', name: 'New service', unit: 'sqm', rate: 20, paint: null, per_coat: false, min_charge: 0, enabled: true }) }
    else if (act === 'rmsvc') { j.custom = j.custom.filter(function (c) { return c.service_id !== state.services[i].id }); state.services.splice(i, 1) }
    else if (act === 'obnext') { if (obStep === 2) applyProfile(); obStep++ }
    else if (act === 'obback') obStep--
    else if (act === 'obfinish') { state.onboarded = true; tab = 'quote'; window.scrollTo(0, 0) }
    else if (act === 'rmextra') j.extras.splice(i, 1)
    else if (act === 'addext') j.exterior = P.emptyExterior()
    else if (act === 'rmext') j.exterior = null
    else if (act === 'addequip') j.equipment.push({ name: '', cost: '' })
    else if (act === 'rmequip') j.equipment.splice(i, 1)
    else if (act === 'analyse') return analysePhotos()
    else if (act === 'roof') return measureRoof()
    else if (act === 'auth-signup') { authMode = 'signup'; authMsg = ''; tab = 'auth'; render(); return }
    else if (act === 'auth-login') { authMode = 'login'; authMsg = ''; tab = 'auth'; render(); return }
    else if (act === 'auth-forgot') { authMode = 'forgot'; authMsg = ''; render(); return }
    else if (act === 'authback') { tab = state.onboarded ? 'settings' : 'welcome'; render(); return }
    else if (act === 'skipauth') { state.skipAuth = true; localSave(); tab = 'onboard'; obStep = 1; render(); return }
    else if (act === 'signout') return signOut()
    else if (act === 'share') return sharePdf()
    else if (act === 'download') return downloadPdf()
    else if (act === 'rmlogo') { delete state.org.logo; delete state.org.logo_w; delete state.org.logo_h; delete state.org.logo_type }
    else if (act === 'save') return saveQuote()
    else if (act === 'pdf') return printQuote()
    else if (act === 'clear') { if (confirm('Start a new blank quote?')) state.draft = newDraft(); else return }
    else if (act === 'openq') { state.draft = JSON.parse(JSON.stringify(state.quotes[i].draft)); if (!state.draft.job.custom) state.draft.job.custom = []; tab = 'quote' }
    else if (act === 'delq') { if (confirm('Delete this saved quote?')) { var gone = state.quotes.splice(i, 1)[0]; queueQuote(gone.draft.id, 'delete') } else return }
    else if (act === 'rmprod') { if (state.products.filter(function (x) { return x.category === state.products[i].category }).length > 1) { state.products.splice(i, 1) } else { alert('Keep at least one product in each group.'); return } }
    else if (act === 'addprod') { state.products.push({ id: uid(), category: b.dataset.cat, name: 'New product', pack_size_l: 10, pack_price: 100, coverage_m2_per_l: 12, is_default: false }) }
    else if (act === 'reset') {
      if (confirm('Reset all prices, paint and saved quotes to the demo defaults?' + (cloudUser ? ' This also replaces what is saved in your account.' : ''))) {
        var ids = state.quotes.map(function (x) { return x.draft.id }), keepOwner = state.owner
        state = defaults(); normalise(); tab = 'onboard'; obStep = 1
        if (cloudUser) { state.owner = keepOwner; state.syncDirty = true; ids.forEach(function (id) { state.pendingQ.push({ id: id, op: 'delete' }) }) }
      } else return
    }
    else return
    save(); render()
  })

  function saveQuote(silent) {
    var d = state.draft, q = calc(d)
    if (!q.total) { if (!silent) alert('Add at least one room or surface first.'); return }
    var existing = state.quotes.filter(function (s) { return s.draft.id === d.id })[0]
    var number = existing ? existing.number : state.org.quote_prefix + state.org.next_number++
    var rec = { number: number, date: today(), customer: d.customer, total: q.total, draft: JSON.parse(JSON.stringify(d)) }
    if (existing) state.quotes[state.quotes.indexOf(existing)] = rec; else state.quotes.push(rec)
    save(); queueQuote(d.id, 'upsert'); if (!silent) toast('Saved as ' + number)
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
    var h = '<div class="doc"><div class="hd"><div>' + (o.logo ? '<img src="' + o.logo + '" style="max-height:60px;max-width:200px;margin-bottom:6px"><br>' : '') + '<h1>' + esc(o.name) + '</h1><div class="meta">' + [o.abn && 'ABN ' + esc(o.abn), o.licence && 'QBCC Lic. ' + esc(o.licence), esc(o.phone), esc(o.email)].filter(Boolean).join(' · ') + '</div></div>'
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

  document.addEventListener('submit', function (e) {
    if (e.target.id === 'authForm') { e.preventDefault(); submitAuth() }
    else if (e.target.id === 'recoverForm') { e.preventDefault(); submitRecover() }
  })
  window.addEventListener('online', function () { if (cloudUser) syncNow() })

  window.__pq = { state: function () { return state }, calc: calc, buildDoc: buildDoc }
  render()
  if (sb) {
    sb.auth.onAuthStateChange(function (ev, sess) {
      if (ev === 'PASSWORD_RECOVERY') { tab = 'recover'; authMsg = ''; setTimeout(render, 0); return }
      if (sess && sess.user && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION')) {
        if (!cloudUser || cloudUser.id !== sess.user.id) setTimeout(function () { afterSignIn(sess.user) }, 0)
      } else if (ev === 'INITIAL_SESSION' && !sess) {
        if (tab === 'loading') { tab = state.skipAuth ? 'onboard' : 'welcome'; setTimeout(render, 0) }
      }
    })
  }
})()
