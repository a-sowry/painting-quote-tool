// Pure logic for photo analysis (no network, no Deno APIs) so it can be unit-tested in Node.
export const MAX_IMAGES = 4
export const MAX_IMAGE_CHARS = 2_500_000 // ~1.9 MB of base64 per photo (the app downsizes well below this)
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export const SCHEMAS = {
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

export const SYSTEM = `You help a professional painter estimate surface sizes from phone photos so they can quote faster.
Use real-world reference objects to scale: a standard Australian internal door is about 2.04 m high and 0.82 m wide; an external door about 2.04 m; a standard light switch sits about 1.1-1.2 m above the floor; a kitchen bench is about 0.9 m high; skirting boards are about 0.09 m; a brick course is about 0.076 m (about 13 courses per metre). Typical ceiling height is 2.4 m (older homes 2.7 m+) unless the person tells you otherwise.
A photo cannot show depth precisely. Give your best estimate, never refuse, and lower the confidence when scale references are missing, the room is only partly visible, or the angle is extreme. Multiple photos are of the same space - combine them. Never invent features you cannot see.`

export function toolFor(mode) {
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

export function validate(body) {
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

export function buildAnthropicRequest(body, model) {
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

export function parseResponse(data) {
  const tool = (data?.content ?? []).find((b) => b.type === 'tool_use')
  return tool?.input ?? null
}
