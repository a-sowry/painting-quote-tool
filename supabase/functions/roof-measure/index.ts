// Supabase Edge Function: job address -> roof area, using Google's Geocoding + Solar (Building Insights) APIs.
// The Google key lives only here (secret GOOGLE_MAPS_API_KEY).
import { authenticate, checkUsage, recordUsage } from '../_shared/shared.mjs'
import { validateAddress, geocodeUrl, solarUrl, parseGeocode, parseBuilding } from './core.mjs'

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
