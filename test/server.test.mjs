import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthStartISO, limitFor, codeMatches, authenticate, checkUsage, recordUsage } from '../supabase/functions/_shared/shared.mjs'
import { validateAddress, parseGeocode, parseBuilding, geocodeUrl, solarUrl } from '../supabase/functions/roof-measure/core.mjs'

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', ACCESS_CODE: 'letmein' }
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } })

test('month start is the first of the month in UTC', () => {
  assert.equal(monthStartISO(new Date('2026-11-20T10:00:00Z')), '2026-11-01T00:00:00.000Z')
  assert.equal(monthStartISO(new Date('2026-12-31T23:59:59Z')), '2026-12-01T00:00:00.000Z')
})
test('limits: env value, else 30; bad values fall back', () => {
  assert.equal(limitFor('photo', {}), 30)
  assert.equal(limitFor('photo', { MONTHLY_PHOTO_LIMIT: '5' }), 5)
  assert.equal(limitFor('roof', { MONTHLY_ROOF_LIMIT: '12', MONTHLY_PHOTO_LIMIT: '5' }), 12)
  assert.equal(limitFor('roof', { MONTHLY_ROOF_LIMIT: 'abc' }), 30)
  assert.equal(limitFor('roof', { MONTHLY_ROOF_LIMIT: '' }), 30)
})
test('auth: verified user, owner code, and refusals', async () => {
  const okUser = async (url) => (url.endsWith('/auth/v1/user') ? resp(200, { id: 'u1' }) : resp(500, {}))
  let a = await authenticate({ headers: { authorization: 'Bearer tok', apikey: 'pk' }, env, fetchImpl: okUser })
  assert.deepEqual(a, { ok: true, kind: 'user', userId: 'u1' })
  const badUser = async () => resp(401, {})
  a = await authenticate({ headers: { authorization: 'Bearer tok' }, env, fetchImpl: badUser })
  assert.equal(a.ok, false); assert.equal(a.status, 401)
  a = await authenticate({ headers: { 'x-access-code': 'letmein' }, env, fetchImpl: badUser })
  assert.deepEqual(a, { ok: true, kind: 'code' })
  a = await authenticate({ headers: { 'x-access-code': 'wrong' }, env, fetchImpl: badUser })
  assert.equal(a.ok, false)
  a = await authenticate({ headers: { 'x-access-code': 'anything' }, env: { ...env, ACCESS_CODE: '' }, fetchImpl: badUser })
  assert.equal(a.ok, false, 'unset code never lets anyone in')
  // a Bearer that is just the public key (not signed in) must not count as a user
  a = await authenticate({ headers: { authorization: 'Bearer sb_publishable_x' }, env, fetchImpl: badUser })
  assert.equal(a.ok, false)
})
test('usage: under the limit passes, at the limit is refused, owner code is unlimited', async () => {
  const mk = (n) => async (url, opts) => { assert.match(url, /usage\?select=id&user_id=eq\.u1&kind=eq\.photo&created_at=gte\./); assert.equal(opts.headers.apikey, 'svc'); return resp(206, [], { 'content-range': `0-0/${n}` }) }
  const user = { ok: true, kind: 'user', userId: 'u1' }
  let r = await checkUsage({ auth: user, kind: 'photo', env: { ...env, MONTHLY_PHOTO_LIMIT: '3' }, fetchImpl: mk(2) })
  assert.equal(r.ok, true)
  r = await checkUsage({ auth: user, kind: 'photo', env: { ...env, MONTHLY_PHOTO_LIMIT: '3' }, fetchImpl: mk(3) })
  assert.equal(r.ok, false); assert.equal(r.status, 429); assert.match(r.error, /all 3/)
  r = await checkUsage({ auth: { ok: true, kind: 'code' }, kind: 'photo', env, fetchImpl: () => { throw new Error('should not be called') } })
  assert.equal(r.ok, true)
  r = await checkUsage({ auth: user, kind: 'photo', env, fetchImpl: async () => resp(500, {}) })
  assert.equal(r.status, 503, 'fails closed if usage cannot be checked')
})
test('recordUsage writes one row for users and nothing for the owner code', async () => {
  const calls = []
  const f = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return resp(201, {}) }
  await recordUsage({ auth: { ok: true, kind: 'user', userId: 'u1' }, kind: 'roof', env, fetchImpl: f })
  await recordUsage({ auth: { ok: true, kind: 'code' }, kind: 'roof', env, fetchImpl: f })
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], { user_id: 'u1', kind: 'roof' })
  await recordUsage({ auth: { ok: true, kind: 'user', userId: 'u1' }, kind: 'roof', env, fetchImpl: () => { throw new Error('boom') } }) // never throws
})
test('address validation + urls never leak the key into the address', () => {
  assert.ok(validateAddress({ address: 'x' })); assert.ok(validateAddress(null)); assert.ok(validateAddress({ address: 'a'.repeat(201) }))
  assert.equal(validateAddress({ address: '21 Turley St, Indooroopilly QLD' }), null)
  assert.match(geocodeUrl('21 Turley St & co', 'K'), /address=21%20Turley%20St%20%26%20co/)
  assert.match(solarUrl(-27.5, 153, 'K'), /latitude=-27\.5.*requiredQuality=BASE/)
})
test('geocode parse', () => {
  assert.equal(parseGeocode({ status: 'ZERO_RESULTS', results: [] }), null)
  const g = parseGeocode({ status: 'OK', results: [{ formatted_address: '21 Turley St', geometry: { location: { lat: -27.5, lng: 153 }, location_type: 'ROOFTOP' } }] })
  assert.deepEqual(g, { lat: -27.5, lng: 153, formatted: '21 Turley St', partial: false, type: 'ROOFTOP' })
})
test('roof parse: scales whole-roof by building/ground ratio, weights pitch by area', () => {
  const j = {
    imageryDate: { year: 2024, month: 3, day: 9 }, imageryQuality: 'MEDIUM',
    buildingStats: { areaMeters2: 300, groundAreaMeters2: 250 },
    solarPotential: {
      wholeRoofStats: { areaMeters2: 200, groundAreaMeters2: 160 },
      roofSegmentStats: [
        { pitchDegrees: 20, stats: { areaMeters2: 100 } },
        { pitchDegrees: 30, stats: { areaMeters2: 100 } },
        { pitchDegrees: 99, stats: { areaMeters2: 0 } },
      ],
    },
  }
  const r = parseBuilding(j)
  assert.equal(r.roof_area_m2, Math.round(200 * 250 / 160)) // 313
  assert.equal(r.pitch_deg, 25); assert.equal(r.segments, 2)
  assert.equal(r.imagery_date, '2024-03'); assert.equal(r.imagery_quality, 'MEDIUM')
  // no building stats -> whole roof as-is; ratio capped at 2x
  assert.equal(parseBuilding({ solarPotential: { wholeRoofStats: { areaMeters2: 150, groundAreaMeters2: 120 } } }).roof_area_m2, 150)
  assert.equal(parseBuilding({ buildingStats: { groundAreaMeters2: 1000 }, solarPotential: { wholeRoofStats: { areaMeters2: 100, groundAreaMeters2: 100 } } }).roof_area_m2, 200)
  assert.equal(parseBuilding({}), null); assert.equal(parseBuilding({ solarPotential: { wholeRoofStats: { areaMeters2: 0 } } }), null)
})
