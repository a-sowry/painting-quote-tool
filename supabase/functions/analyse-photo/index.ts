// Supabase Edge Function: photo -> painting measurements, using Claude's vision API.
// The Anthropic key lives only here (secret ANTHROPIC_API_KEY), never in the website.
// Callers must send the shared access code (header x-access-code) that matches the ACCESS_CODE secret.
import { validate, codeMatches, buildAnthropicRequest, parseResponse } from './core.mjs'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-access-code',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Naive per-instance limiter: a speed bump against a leaked code, not a guarantee.
const hits: number[] = []
const WINDOW_MS = 10 * 60 * 1000
const MAX_CALLS = 40

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const expected = Deno.env.get('ACCESS_CODE') ?? ''
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!expected || !key) return json(503, { error: 'Photo analysis is not switched on yet.' })
  if (!codeMatches(req.headers.get('x-access-code') ?? '', expected)) return json(401, { error: 'Wrong or missing access code' })

  let body: any
  try { body = await req.json() } catch { return json(400, { error: 'Bad request' }) }
  const problem = validate(body)
  if (problem) return json(400, { error: problem })

  const now = Date.now()
  while (hits.length && now - hits[0] > WINDOW_MS) hits.shift()
  if (hits.length >= MAX_CALLS) return json(429, { error: 'Too many photo analyses - try again in a few minutes.' })
  hits.push(now)

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
  if (!res.ok) return json(502, { error: `Analysis service error (${res.status})` })
  const estimate = parseResponse(await res.json())
  if (!estimate) return json(502, { error: 'The analysis did not return measurements' })
  return json(200, { estimate, mode: body.mode })
})
