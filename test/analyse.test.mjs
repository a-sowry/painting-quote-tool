import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, buildAnthropicRequest, parseResponse, toolFor } from '../supabase/functions/analyse-photo/core.mjs'

const img = { mediaType: 'image/jpeg', data: 'x'.repeat(200) }
test('validate accepts good input and rejects bad', () => {
  assert.equal(validate({ mode: 'room', images: [img] }), null)
  assert.match(validate({ mode: 'bogus', images: [img] }), /mode/)
  assert.match(validate({ mode: 'room', images: [] }), /at least one/)
  assert.match(validate({ mode: 'room', images: Array(5).fill(img) }), /at most/)
  assert.match(validate({ mode: 'room', images: [{ mediaType: 'image/gif', data: 'x'.repeat(200) }] }), /JPEG/)
  assert.match(validate({ mode: 'room', images: [{ mediaType: 'image/jpeg', data: 'x'.repeat(3_000_000) }] }), /too large/)
  assert.ok(validate(null))
})
test('request asks for the tool and includes the photos and ceiling height', () => {
  const r = buildAnthropicRequest({ mode: 'room', images: [img, img], ceilingHeight: 2.7 }, 'm')
  assert.deepEqual(r.tool_choice, { type: 'auto' })
  assert.match(r.messages[0].content.at(-1).text, /report_measurements/)
  assert.equal(r.messages[0].content.filter((c) => c.type === 'image').length, 2)
  assert.match(r.messages[0].content.at(-1).text, /2\.7 m/)
  assert.ok(toolFor('exterior').input_schema.required.includes('wall_area_m2'))
})
test('parseResponse pulls the tool input', () => {
  assert.deepEqual(parseResponse({ content: [{ type: 'text' }, { type: 'tool_use', input: { a: 1 } }] }), { a: 1 })
  assert.equal(parseResponse({ content: [] }), null)
})
