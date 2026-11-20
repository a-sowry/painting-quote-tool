// Pure logic for roof measuring from a street address (Google Geocoding + Solar APIs).

export function validateAddress(body) {
  const a = body && typeof body.address === 'string' ? body.address.trim() : ''
  if (a.length < 6) return 'Enter the full job address first (street, suburb, state).'
  if (a.length > 200) return 'That address is too long.'
  return null
}

export const geocodeUrl = (address, key) =>
  `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=au&components=${encodeURIComponent('country:AU')}&key=${encodeURIComponent(key)}`

export const solarUrl = (lat, lng, key) =>
  `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=BASE&key=${encodeURIComponent(key)}`

export function parseGeocode(json) {
  const r = json?.results?.[0]
  const loc = r?.geometry?.location
  if (json?.status !== 'OK' || !loc) return null
  return { lat: loc.lat, lng: loc.lng, formatted: r.formatted_address, partial: Boolean(r.partial_match), type: r.geometry.location_type }
}

const round1 = (n) => Math.round(n * 10) / 10

// Google: whole-roof stats only cover roof the model assigned to segments. Their docs suggest scaling it
// by the ratio of building to whole-roof ground area for a more reliable whole-building figure.
export function parseBuilding(json) {
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
