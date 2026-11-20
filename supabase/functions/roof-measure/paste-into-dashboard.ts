// GENERATED single-file copy of _shared/shared.mjs + roof-measure/core.mjs + roof-measure/index.ts.
// Regenerate with: python3 tools/build-paste.py
// Shared by every PaintQuote function: who is calling, and are they within their monthly limit?
// Pure logic with fetch/env passed in, so it can be unit-tested without a network.

function monthStartISO(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function limitFor(kind, env) {
  const raw = env[kind === 'roof' ? 'MONTHLY_ROOF_LIMIT' : 'MONTHLY_PHOTO_LIMIT']
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && raw !== undefined && raw !== '' ? n : 30
}

// Constant-time-ish comparison so the access code can't be guessed by timing.
function codeMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// A signed-in painter (verified with Supabase) is allowed, and limited. The owner's shared
// access code is also allowed, unlimited - handy for trying things out. Anyone else is refused.
async function authenticate({ headers, env, fetchImpl = fetch }) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) ?? ''
  const bearer = get('authorization')
  const apikey = get('apikey')
  // The owner's access code (unlimited) is checked first, then a signed-in painter's token (limited).
  if (codeMatches(get('x-access-code'), env.ACCESS_CODE ?? '')) return { ok: true, kind: 'code' }
  if (bearer.startsWith('Bearer ') && env.SUPABASE_URL) {
    try {
      const res = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey, Authorization: bearer } })
      if (res.ok) {
        const user = await res.json()
        if (user?.id) return { ok: true, kind: 'user', userId: user.id }
      }
    } catch { /* not a valid session */ }
  }
  return { ok: false, status: 401, error: 'Log in to use this.' }
}

const svc = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` })

// Call before doing the (paid) work. Returns { ok, used, limit } or { ok:false, status, error }.
async function checkUsage({ auth, kind, env, fetchImpl = fetch, now = new Date() }) {
  if (auth.kind !== 'user') return { ok: true } // owner code: unlimited
  const limit = limitFor(kind, env)
  const url = `${env.SUPABASE_URL}/rest/v1/usage?select=id&user_id=eq.${auth.userId}&kind=eq.${kind}&created_at=gte.${encodeURIComponent(monthStartISO(now))}`
  let res
  try {
    res = await fetchImpl(url, { headers: { ...svc(env), Prefer: 'count=exact', Range: '0-0' } })
  } catch { return { ok: false, status: 503, error: 'Could not check your usage - try again.' } }
  if (!res.ok && res.status !== 206) return { ok: false, status: 503, error: 'Could not check your usage - try again.' }
  const total = Number((res.headers.get('content-range') ?? '').split('/')[1])
  const used = Number.isFinite(total) ? total : 0
  if (used >= limit) return { ok: false, status: 429, error: `You've used all ${limit} of this month's ${kind === 'roof' ? 'roof lookups' : 'photo measurements'}. They reset on the 1st.` }
  return { ok: true, used, limit }
}

// Call after the work succeeded, so failures don't use up the allowance.
async function recordUsage({ auth, kind, env, fetchImpl = fetch }) {
  if (auth.kind !== 'user') return
  try {
    await fetchImpl(`${env.SUPABASE_URL}/rest/v1/usage`, {
      method: 'POST',
      headers: { ...svc(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: auth.userId, kind }),
    })
  } catch { /* never fail the painter's request over bookkeeping */ }
}

// Pure logic for roof measuring from a street address (Google Geocoding + Solar APIs).

function validateAddress(body) {
  const a = body && typeof body.address === 'string' ? body.address.trim() : ''
  if (a.length < 6) return 'Enter the full job address first (street, suburb, state).'
  if (a.length > 200) return 'That address is too long.'
  return null
}

const geocodeUrl = (address, key) =>
  `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=au&components=${encodeURIComponent('country:AU')}&key=${encodeURIComponent(key)}`

const solarUrl = (lat, lng, key) =>
  `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=BASE&key=${encodeURIComponent(key)}`

function parseGeocode(json) {
  const r = json?.results?.[0]
  const loc = r?.geometry?.location
  if (json?.status !== 'OK' || !loc) return null
  return { lat: loc.lat, lng: loc.lng, formatted: r.formatted_address, partial: Boolean(r.partial_match), type: r.geometry.location_type }
}

const round1 = (n) => Math.round(n * 10) / 10

// Google: whole-roof stats only cover roof the model assigned to segments. Their docs suggest scaling it
// by the ratio of building to whole-roof ground area for a more reliable whole-building figure.
function parseBuilding(json) {
  const sp = json?.solarPotential
  const whole = sp?.wholeRoofStats
  if (!whole || !(whole.areaMeters2 > 0)) return null
  const b = json.buildingStats
  let area = whole.areaMeters2
  if (b && whole.groundAreaMeters2 > 0 && b.groundAreaMeters2 > whole.groundAreaMeters2) {
    area = whole.areaMeters2 * Math.min(2, b.groundAreaMeters2 / whole.groundAreaMeters2)
  }
  const segs = (sp.roofSegmentStats ?? []).filter((s) => s?.stats?.areaMeters2 > 0 && Number.isFinite(s.pitchDegrees))
  const segArea = segs.reduce((t, s) => t + s.stats.areaMeters2, 0)
  const pitch = segArea > 0 ? segs.reduce((t, s) => t + s.pitchDegrees * s.stats.areaMeters2, 0) / segArea : null
  const d = json.imageryDate
  return {
    roof_area_m2: Math.round(area),
    ground_area_m2: Math.round(b?.groundAreaMeters2 ?? whole.groundAreaMeters2 ?? 0),
    pitch_deg: pitch == null ? null : round1(pitch),
    segments: segs.length,
    imagery_date: d && d.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}` : null,
    imagery_quality: json.imageryQuality ?? null,
  }
}

// Supabase Edge Function: job address -> roof area, using Google's Geocoding + Solar (Building Insights) APIs.
// The Google key lives only here (secret GOOGLE_MAPS_API_KEY).

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-access-code',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const env = Deno.env.toObject()
  if (!env.GOOGLE_MAPS_API_KEY) return json(503, { error: 'Roof measuring is not switched on yet.' })

  const auth = await authenticate({ headers: req.headers, env })
  if (!auth.ok) return json(auth.status, { error: auth.error })

  let body: any
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }
  const problem = validateAddress(body)
  if (problem) return json(400, { error: problem })

  const usage = await checkUsage({ auth, kind: 'roof', env })
  if (!usage.ok) return json(usage.status, { error: usage.error })

  let geo
  try {
    const g = await fetch(geocodeUrl(body.address.trim(), env.GOOGLE_MAPS_API_KEY))
    geo = parseGeocode(await g.json())
  } catch { return json(502, { error: 'Could not reach the address service' }) }
  if (!geo) return json(404, { error: 'Could not find that address. Add the suburb and state and try again.' })

  let res: Response
  try { res = await fetch(solarUrl(geo.lat, geo.lng, env.GOOGLE_MAPS_API_KEY)) }
  catch { return json(502, { error: 'Could not reach the roof data service' }) }
  if (res.status === 404) return json(404, { error: 'No aerial roof data for that address. Enter the roof size by hand or use a photo.' })
  if (!res.ok) {
    let why = ''
    try { why = (await res.json())?.error?.message ?? '' } catch { /* not JSON */ }
    console.error('solar error', res.status, why)
    return json(502, { error: `Roof data service error (${res.status})${why ? ': ' + String(why).slice(0, 160) : ''}` })
  }
  const roof = parseBuilding(await res.json())
  if (!roof) return json(404, { error: 'No usable roof data for that address. Enter the size by hand.' })

  await recordUsage({ auth, kind: 'roof', env })
  return json(200, { roof: { ...roof, address: geo.formatted, approximate: geo.partial || (geo.type && geo.type !== 'ROOFTOP' && geo.type !== 'RANGE_INTERPOLATED') } })
})
