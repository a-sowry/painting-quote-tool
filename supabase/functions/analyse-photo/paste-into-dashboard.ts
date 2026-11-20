// GENERATED single-file copy of _shared/shared.mjs + analyse-photo/core.mjs + analyse-photo/index.ts.
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

// Pure logic for photo analysis (no network, no Deno APIs) so it can be unit-tested in Node.
const MAX_IMAGES = 4
const MAX_IMAGE_CHARS = 2_500_000 // ~1.9 MB of base64 per photo (the app downsizes well below this)
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const SCHEMAS = {
  room: {
    description: 'Estimated size of the room in the photo(s), to price a repaint. Metres. Estimate even when unsure and say so via confidence.',
    properties: {
      length_m: { type: 'number', description: 'Longer floor dimension in metres' },
      width_m: { type: 'number', description: 'Shorter floor dimension in metres' },
      height_m: { type: 'number', description: 'Floor to ceiling height in metres' },
      doors: { type: 'integer', description: 'Door openings into/out of the room' },
      windows: { type: 'integer', description: 'Windows in the room' },
    },
    required: ['length_m', 'width_m', 'height_m', 'doors', 'windows'],
  },
  wall: {
    description: 'Estimated size of the single wall (or feature wall) in the photo, in metres.',
    properties: {
      wall_width_m: { type: 'number', description: 'Width of the wall in metres' },
      wall_height_m: { type: 'number', description: 'Height of the wall in metres' },
    },
    required: ['wall_width_m', 'wall_height_m'],
  },
  exterior: {
    description: 'Estimated paintable exterior of the house in the photo(s). Wall area is the visible painted wall surface in square metres, excluding windows and doors.',
    properties: {
      wall_area_m2: { type: 'number', description: 'Paintable exterior wall area, m2, excluding openings' },
      trim_length_m: { type: 'number', description: 'Approx. metres of eaves, fascia and gutters' },
      storeys: { type: 'integer', description: '1, 2 or 3' },
      doors: { type: 'integer', description: 'Exterior doors (incl. garage door as 1)' },
      windows: { type: 'integer', description: 'Windows' },
    },
    required: ['wall_area_m2', 'trim_length_m', 'storeys', 'doors', 'windows'],
  },
}

const SYSTEM = `You help a professional painter estimate surface sizes from phone photos so they can quote faster.
Use real-world reference objects to scale: a standard Australian internal door is about 2.04 m high and 0.82 m wide; an external door about 2.04 m; a standard light switch sits about 1.1-1.2 m above the floor; a kitchen bench is about 0.9 m high; skirting boards are about 0.09 m; a brick course is about 0.076 m (about 13 courses per metre). Typical ceiling height is 2.4 m (older homes 2.7 m+) unless the person tells you otherwise.
A photo cannot show depth precisely. Give your best estimate, never refuse, and lower the confidence when scale references are missing, the room is only partly visible, or the angle is extreme. Multiple photos are of the same space - combine them. Never invent features you cannot see.`

function toolFor(mode) {
  const s = SCHEMAS[mode]
  return {
    name: 'report_measurements',
    description: s.description,
    input_schema: {
      type: 'object',
      properties: {
        ...s.properties,
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How reliable the numbers are given what is visible' },
        reasoning: { type: 'string', description: 'One or two sentences: which reference objects you used and what is hidden or uncertain' },
      },
      required: [...s.required, 'confidence', 'reasoning'],
    },
  }
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'Missing request body'
  if (!SCHEMAS[body.mode]) return 'mode must be room, wall or exterior'
  if (!Array.isArray(body.images) || body.images.length < 1) return 'Send at least one photo'
  if (body.images.length > MAX_IMAGES) return `Send at most ${MAX_IMAGES} photos`
  for (const img of body.images) {
    if (!img || !ALLOWED_TYPES.includes(img.mediaType)) return 'Photos must be JPEG, PNG or WebP'
    if (typeof img.data !== 'string' || img.data.length < 100) return 'A photo is empty'
    if (img.data.length > MAX_IMAGE_CHARS) return 'A photo is too large - try a smaller image'
  }
  return null
}

function buildAnthropicRequest(body, model) {
  const height = Number(body.ceilingHeight)
  const text =
    `Mode: ${body.mode}. ` +
    (body.mode === 'room' && height > 0 ? `The person says the ceiling height is ${height} m - use that. ` : '') +
    `Estimate the measurements from the ${body.images.length > 1 ? 'photos' : 'photo'} and report them by calling the report_measurements tool. Do not reply with plain text.`
  return {
    model,
    max_tokens: 1024,
    system: SYSTEM,
    tools: [toolFor(body.mode)],
    // Some models reject a forced tool call, so ask for it in the prompt and let the model choose it.
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        ...body.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ],
    }],
  }
}

function parseResponse(data) {
  const tool = (data?.content ?? []).find((b) => b.type === 'tool_use')
  return tool?.input ?? null
}

// Supabase Edge Function: photo -> painting measurements, using Claude's vision API.
// The Anthropic key lives only here (secret ANTHROPIC_API_KEY), never in the website.
// Callers must send the shared access code (header x-access-code) that matches the ACCESS_CODE secret.

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
  if (!env.ANTHROPIC_API_KEY) return json(503, { error: 'Photo analysis is not switched on yet.' })
  const key = env.ANTHROPIC_API_KEY

  const auth = await authenticate({ headers: req.headers, env })
  if (!auth.ok) return json(auth.status, { error: auth.error })

  let body: any
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }
  const problem = validate(body)
  if (problem) return json(400, { error: problem })

  const usage = await checkUsage({ auth, kind: 'photo', env })
  if (!usage.ok) return json(usage.status, { error: usage.error })

  const model = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5'
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildAnthropicRequest(body, model)),
    })
  } catch {
    return json(502, { error: 'Could not reach the analysis service' })
  }
  if (!res.ok) {
    // Pass Anthropic's own reason through (e.g. low credit balance, bad model name) - it never contains the key.
    let why = ''
    try { why = (await res.json())?.error?.message ?? '' } catch { /* not JSON */ }
    console.error('anthropic error', res.status, why)
    return json(502, { error: `Analysis service error (${res.status})${why ? ': ' + String(why).slice(0, 200) : ''}` })
  }
  const estimate = parseResponse(await res.json())
  if (!estimate) return json(502, { error: 'The analysis did not return measurements' })
  await recordUsage({ auth, kind: 'photo', env })
  return json(200, { estimate, mode: body.mode })
})
