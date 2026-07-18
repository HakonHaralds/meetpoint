export interface LatLon {
  lat: number
  lon: number
}

const EARTH_RADIUS_M = 6371000

/** Great-circle distance in meters. */
export function haversine(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Spherical centroid: mean of the points' 3D unit vectors, projected back to the sphere. */
export function centroid(points: LatLon[]): LatLon {
  const toRad = (d: number) => (d * Math.PI) / 180
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    const lat = toRad(p.lat)
    const lon = toRad(p.lon)
    x += Math.cos(lat) * Math.cos(lon)
    y += Math.cos(lat) * Math.sin(lon)
    z += Math.sin(lat)
  }
  x /= points.length
  y /= points.length
  z /= points.length
  const lon = Math.atan2(y, x)
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y))
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI }
}

/**
 * Geometric median (Weiszfeld's algorithm): the point minimizing the sum of
 * straight-line distances to all inputs. Computed in a local planar projection,
 * which is accurate at city scale.
 */
export function geometricMedian(points: LatLon[]): LatLon {
  const origin = centroid(points)
  const metersPerDegLat = 111320
  const metersPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180)
  const pts = points.map((p) => ({
    x: (p.lon - origin.lon) * metersPerDegLon,
    y: (p.lat - origin.lat) * metersPerDegLat,
  }))

  let cx = 0
  let cy = 0
  for (let iter = 0; iter < 100; iter++) {
    let numX = 0
    let numY = 0
    let denom = 0
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy)
      if (d < 0.1) return { lat: origin.lat + cy / metersPerDegLat, lon: origin.lon + cx / metersPerDegLon }
      numX += p.x / d
      numY += p.y / d
      denom += 1 / d
    }
    const nx = numX / denom
    const ny = numY / denom
    const moved = Math.hypot(nx - cx, ny - cy)
    cx = nx
    cy = ny
    if (moved < 0.5) break
  }
  return { lat: origin.lat + cy / metersPerDegLat, lon: origin.lon + cx / metersPerDegLon }
}

/** n×n grid of candidate points covering a square of ±halfWidthMeters around center. */
export function gridAround(center: LatLon, halfWidthMeters: number, n: number): LatLon[] {
  const metersPerDegLat = 111320
  const metersPerDegLon = 111320 * Math.cos((center.lat * Math.PI) / 180)
  const out: LatLon[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = -halfWidthMeters + (2 * halfWidthMeters * i) / (n - 1)
      const dy = -halfWidthMeters + (2 * halfWidthMeters * j) / (n - 1)
      out.push({
        lat: center.lat + dy / metersPerDegLat,
        lon: center.lon + dx / metersPerDegLon,
      })
    }
  }
  return out
}
