// Shared by every PaintQuote function: who is calling, and are they within their monthly limit?
// Pure logic with fetch/env passed in, so it can be unit-tested without a network.

export function monthStartISO(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

export function limitFor(kind, env) {
  const raw = env[kind === 'roof' ? 'MONTHLY_ROOF_LIMIT' : 'MONTHLY_PHOTO_LIMIT']
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && raw !== undefined && raw !== '' ? n : 30
}

// Constant-time-ish comparison so the access code can't be guessed by timing.
export function codeMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// A signed-in painter (verified with Supabase) is allowed, and limited. The owner's shared
// access code is also allowed, unlimited - handy for trying things out. Anyone else is refused.
export async function authenticate({ headers, env, fetchImpl = fetch }) {
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
export async function checkUsage({ auth, kind, env, fetchImpl = fetch, now = new Date() }) {
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
export async function recordUsage({ auth, kind, env, fetchImpl = fetch }) {
  if (auth.kind !== 'user') return
  try {
    await fetchImpl(`${env.SUPABASE_URL}/rest/v1/usage`, {
      method: 'POST',
      headers: { ...svc(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: auth.userId, kind }),
    })
  } catch { /* never fail the painter's request over bookkeeping */ }
}
