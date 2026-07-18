import { driveDurations } from './api'
import { geometricMedian, gridAround, haversine, type LatLon } from './geo'

export type DrivingKind = 'fastest' | 'fairest' | 'equal'

export type DrivingCenters = Record<DrivingKind, LatLon>

const GRID_N = 7
const REFINE_PASSES = 2

const KIND_LABEL: Record<DrivingKind, string> = {
  fastest: 'fastest-overall spot',
  fairest: 'fairest spot',
  equal: 'equal-time spot',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Scored {
  p: LatLon
  times: number[]
}

/**
 * Lower is better. 'equal' minimizes the gap between the longest and shortest
 * drive; the small mean term picks the closest point on the equal-time locus
 * instead of an equally-far-for-everyone spot out in the countryside.
 */
function scoreOf(kind: DrivingKind, times: number[]): number {
  const total = times.reduce((a, b) => a + b, 0)
  switch (kind) {
    case 'fastest':
      return total
    case 'fairest':
      return Math.max(...times)
    case 'equal':
      return Math.max(...times) - Math.min(...times) + 0.1 * (total / times.length)
  }
}

async function evaluate(homes: LatLon[], candidates: LatLon[]): Promise<Scored[]> {
  const durations = await driveDurations(homes, candidates)
  const out: Scored[] = []
  for (let j = 0; j < candidates.length; j++) {
    const times = durations.map((row) => row[j])
    if (times.some((t) => t == null)) continue
    out.push({ p: candidates[j], times: times as number[] })
  }
  return out
}

/**
 * Iterative grid search over real drive times: one seed grid covering all
 * homes, then per-criterion refinement grids zooming in on that criterion's
 * best candidate. ~7 matrix requests total, gentle on the public server.
 */
export async function findDrivingCenters(
  homes: LatLon[],
  report: (msg: string) => void,
): Promise<DrivingCenters> {
  const seedCenter = geometricMedian(homes)
  const seedRadius = Math.max(1000, ...homes.map((h) => haversine(seedCenter, h)))

  report('Scanning the area for drivable meeting spots…')
  const seed = await evaluate(homes, gridAround(seedCenter, seedRadius, GRID_N))
  if (seed.length === 0) {
    throw new Error('No drivable meeting point found — check that every home is reachable by road.')
  }

  const result = {} as DrivingCenters
  for (const kind of ['fastest', 'fairest', 'equal'] as DrivingKind[]) {
    let best = seed.reduce((a, b) => (scoreOf(kind, b.times) < scoreOf(kind, a.times) ? b : a))
    let radius = seedRadius / 2.5
    for (let pass = 0; pass < REFINE_PASSES; pass++) {
      await sleep(350)
      report(`Refining the ${KIND_LABEL[kind]} — pass ${pass + 1} of ${REFINE_PASSES}…`)
      const scored = await evaluate(homes, gridAround(best.p, radius, GRID_N))
      for (const s of scored) {
        if (scoreOf(kind, s.times) < scoreOf(kind, best.times)) best = s
      }
      radius = Math.max(radius / 2.5, 200)
    }
    result[kind] = best.p
  }
  return result
}
