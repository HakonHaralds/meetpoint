import type { LatLon } from './geo'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const OSRM = 'https://router.project-osrm.org'

export interface GeocodeResult extends LatLon {
  label: string
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=5`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Address search failed (HTTP ${res.status})`)
  const data = (await res.json()) as { display_name: string; lat: string; lon: string }[]
  return data.map((d) => ({ label: d.display_name, lat: Number(d.lat), lon: Number(d.lon) }))
}

export async function reverseGeocode(p: LatLon): Promise<string> {
  const fallback = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`
  try {
    const url = `${NOMINATIM}/reverse?lat=${p.lat}&lon=${p.lon}&format=jsonv2&zoom=16`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return fallback
    const data = (await res.json()) as { display_name?: string }
    return data.display_name ?? fallback
  } catch {
    return fallback
  }
}

/** Road route geometry from A to B as [lat, lon] pairs, for drawing on the map. */
export async function driveRoute(from: LatLon, to: LatLon): Promise<[number, number][]> {
  const coords = `${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to.lon.toFixed(5)},${to.lat.toFixed(5)}`
  const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Routing service failed (HTTP ${res.status})`)
  const data = (await res.json()) as {
    code: string
    routes: { geometry: { coordinates: [number, number][] } }[]
  }
  if (data.code !== 'Ok' || data.routes.length === 0) throw new Error(`No route: ${data.code}`)
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon])
}

/**
 * Drive-time matrix from each source to each destination, in seconds.
 * durations[sourceIndex][destIndex]; null where no route exists.
 */
export async function driveDurations(
  sources: LatLon[],
  dests: LatLon[],
): Promise<(number | null)[][]> {
  const coords = [...sources, ...dests]
    .map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`)
    .join(';')
  const srcIdx = sources.map((_, i) => i).join(';')
  const dstIdx = dests.map((_, i) => i + sources.length).join(';')
  const url = `${OSRM}/table/v1/driving/${coords}?sources=${srcIdx}&destinations=${dstIdx}&annotations=duration`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Routing service failed (HTTP ${res.status})`)
  const data = (await res.json()) as { code: string; durations: (number | null)[][] }
  if (data.code !== 'Ok') throw new Error(`Routing service error: ${data.code}`)
  return data.durations
}
