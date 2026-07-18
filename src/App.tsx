import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { geocode, reverseGeocode, driveDurations, driveRoute, type GeocodeResult } from './api'
import { centroid, geometricMedian, haversine, type LatLon } from './geo'
import { findDrivingCenters } from './drivingCenter'
import './App.css'

interface HomePoint extends LatLon {
  id: string
  label: string
}

type CenterKind = 'centroid' | 'median' | 'fastest' | 'fairest' | 'equal'

interface CenterResult extends LatLon {
  kind: CenterKind
  title: string
  description: string
  color: string
  badge: string
  /** Drive time in seconds per home, same order as points; null = no route. */
  times: (number | null)[] | null
}

const PERSON_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#be185d']

const CENTER_STYLE: Record<CenterKind, { title: string; description: string; color: string; badge: string }> = {
  centroid: {
    title: 'Geographic center',
    description: 'Average of all positions (straight-line centroid).',
    color: '#0ea5e9',
    badge: 'G',
  },
  median: {
    title: 'Straight-line fair point',
    description: 'Minimizes the total straight-line distance for the group.',
    color: '#8b5cf6',
    badge: 'M',
  },
  fastest: {
    title: 'Driving — fastest overall',
    description: 'Minimizes the sum of everyone’s drive times.',
    color: '#16a34a',
    badge: 'D',
  },
  fairest: {
    title: 'Driving — fairest',
    description: 'Minimizes the longest single drive.',
    color: '#f59e0b',
    badge: 'F',
  },
  equal: {
    title: 'Driving — equal time',
    description: 'Everyone drives about the same time (best effort, favoring closer spots).',
    color: '#db2777',
    badge: 'E',
  },
}

const STORAGE_KEY = 'meetpoint.points'

function shortLabel(label: string): string {
  const parts = label.split(',')
  return parts.length >= 2 ? `${parts[0].trim()}, ${parts[1].trim()}` : label
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`
}

function loadPoints(): HomePoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as HomePoint[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default function App() {
  const [points, setPoints] = useState<HomePoint[]>(loadPoints)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [clickMode, setClickMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [centers, setCenters] = useState<CenterResult[]>([])
  const [selected, setSelected] = useState<CenterKind | null>(null)

  const mapRef = useRef<L.Map | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const homeLayerRef = useRef<L.LayerGroup | null>(null)
  const centerLayerRef = useRef<L.LayerGroup | null>(null)
  const linesLayerRef = useRef<L.LayerGroup | null>(null)
  const routeCacheRef = useRef(new Map<string, [number, number][]>())
  const clickModeRef = useRef(clickMode)
  clickModeRef.current = clickMode
  const pointsRef = useRef(points)
  pointsRef.current = points

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(points))
  }, [points])

  // Initialize the map once.
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return
    const map = L.map(mapDivRef.current).setView([64.13, -21.9], 11)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)
    linesLayerRef.current = L.layerGroup().addTo(map)
    homeLayerRef.current = L.layerGroup().addTo(map)
    centerLayerRef.current = L.layerGroup().addTo(map)

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!clickModeRef.current) return
      addPoint({ lat: e.latlng.lat, lon: e.latlng.lng })
    })

    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync home markers.
  useEffect(() => {
    const layer = homeLayerRef.current
    if (!layer) return
    layer.clearLayers()
    points.forEach((p, i) => {
      const color = PERSON_COLORS[i % PERSON_COLORS.length]
      L.circleMarker([p.lat, p.lon], {
        radius: 9,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(shortLabel(p.label))
        .addTo(layer)
    })
    if (points.length > 0 && mapRef.current) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]))
      mapRef.current.fitBounds(bounds.pad(0.3), { maxZoom: 14 })
    }
  }, [points])

  // Sync center markers.
  useEffect(() => {
    const layer = centerLayerRef.current
    if (!layer) return
    layer.clearLayers()
    for (const c of centers) {
      const icon = L.divIcon({
        className: '',
        html: `<div class="center-badge" style="background:${c.color}">${c.badge}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      const timesHtml = c.times
        ? `<ul class="popup-times">${pointsRef.current
            .map((p, i) => `<li>${shortLabel(p.label)}: <b>${formatDuration(c.times![i])}</b></li>`)
            .join('')}</ul>`
        : ''
      L.marker([c.lat, c.lon], { icon })
        .bindPopup(`<b>${c.title}</b><br>${c.description}${timesHtml}`)
        .on('click', () => setSelected(c.kind))
        .addTo(layer)
    }
  }, [centers])

  // Draw travel lines from every home to the selected center: straight dashed
  // lines for the geographic centers, real road routes for the driving ones.
  useEffect(() => {
    const layer = linesLayerRef.current
    if (!layer) return
    layer.clearLayers()
    if (!selected) return
    const c = centers.find((x) => x.kind === selected)
    if (!c) return
    const homes = pointsRef.current

    const straightLine = (p: HomePoint, i: number, tooltip: string) =>
      L.polyline(
        [
          [p.lat, p.lon],
          [c.lat, c.lon],
        ],
        {
          color: PERSON_COLORS[i % PERSON_COLORS.length],
          weight: 3,
          opacity: 0.7,
          dashArray: '6 8',
        },
      )
        .bindTooltip(tooltip)
        .addTo(layer)

    if (c.kind === 'centroid' || c.kind === 'median') {
      homes.forEach((p, i) =>
        straightLine(p, i, `${shortLabel(p.label)} — ${(haversine(p, c) / 1000).toFixed(1)} km straight line`),
      )
      return
    }

    // Driving centers: dashed placeholders now, swapped for road routes as they load.
    let cancelled = false
    homes.forEach((p, i) => {
      const tooltip = `${shortLabel(p.label)} — ${formatDuration(c.times?.[i] ?? null)} drive`
      const placeholder = straightLine(p, i, tooltip)
      const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}:${p.id}`
      const cached = routeCacheRef.current.get(key)
      const draw = (coords: [number, number][]) => {
        if (cancelled) return
        layer.removeLayer(placeholder)
        L.polyline(coords, {
          color: PERSON_COLORS[i % PERSON_COLORS.length],
          weight: 4,
          opacity: 0.8,
        })
          .bindTooltip(tooltip)
          .addTo(layer)
      }
      if (cached) {
        draw(cached)
        return
      }
      // Stagger requests slightly to stay polite to the public OSRM server.
      new Promise((r) => setTimeout(r, i * 200))
        .then(() => driveRoute(p, c))
        .then((coords) => {
          routeCacheRef.current.set(key, coords)
          draw(coords)
        })
        .catch(() => {
          /* keep the dashed placeholder if routing fails */
        })
    })
    return () => {
      cancelled = true
    }
  }, [selected, centers])

  function addPoint(p: LatLon, label?: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const placeholder = label ?? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`
    setPoints((prev) => [...prev, { id, label: placeholder, lat: p.lat, lon: p.lon }])
    setCenters([])
    setSelected(null)
    if (!label) {
      reverseGeocode(p).then((name) => {
        setPoints((prev) => prev.map((pt) => (pt.id === id ? { ...pt, label: name } : pt)))
      })
    }
  }

  function removePoint(id: string) {
    setPoints((prev) => prev.filter((p) => p.id !== id))
    setCenters([])
    setSelected(null)
  }

  async function runSearch() {
    if (!query.trim() || searching) return
    setSearching(true)
    setError('')
    try {
      const results = await geocode(query.trim())
      setSearchResults(results)
      if (results.length === 0) setError('No matches for that address.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  function pickSearchResult(r: GeocodeResult) {
    addPoint({ lat: r.lat, lon: r.lon }, r.label)
    setSearchResults([])
    setQuery('')
  }

  async function calculate() {
    if (points.length < 2 || busy) return
    setBusy(true)
    setError('')
    setCenters([])
    routeCacheRef.current.clear()
    const homes: LatLon[] = points.map((p) => ({ lat: p.lat, lon: p.lon }))

    const geo = centroid(homes)
    const median = geometricMedian(homes)
    setCenters([
      { kind: 'centroid', ...CENTER_STYLE.centroid, ...geo, times: null },
      { kind: 'median', ...CENTER_STYLE.median, ...median, times: null },
    ])
    setSelected('centroid')

    try {
      const driving = await findDrivingCenters(homes, setStatus)
      setStatus('Fetching final drive times…')
      const finals: LatLon[] = [geo, median, driving.fastest, driving.fairest, driving.equal]
      const durations = await driveDurations(homes, finals)
      const timesFor = (destIdx: number) => durations.map((row) => row[destIdx])
      setCenters([
        { kind: 'centroid', ...CENTER_STYLE.centroid, ...geo, times: timesFor(0) },
        { kind: 'median', ...CENTER_STYLE.median, ...median, times: timesFor(1) },
        { kind: 'fastest', ...CENTER_STYLE.fastest, ...driving.fastest, times: timesFor(2) },
        { kind: 'fairest', ...CENTER_STYLE.fairest, ...driving.fairest, times: timesFor(3) },
        { kind: 'equal', ...CENTER_STYLE.equal, ...driving.equal, times: timesFor(4) },
      ])
      setStatus('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Meetpoint</h1>
        <p className="subtitle">
          Add everyone&apos;s home, then find the middle — as the crow flies and by car.
        </p>

        <div className="search-row">
          <input
            type="text"
            placeholder="Search an address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button onClick={runSearch} disabled={searching || !query.trim()}>
            {searching ? '…' : 'Search'}
          </button>
        </div>

        {searchResults.length > 0 && (
          <ul className="search-results">
            {searchResults.map((r, i) => (
              <li key={i}>
                <button onClick={() => pickSearchResult(r)}>{r.label}</button>
              </li>
            ))}
          </ul>
        )}

        <button
          className={`toggle ${clickMode ? 'active' : ''}`}
          onClick={() => setClickMode((v) => !v)}
        >
          {clickMode ? '✓ Click the map to add a point (on)' : 'Add points by clicking the map'}
        </button>

        <h2>Homes ({points.length})</h2>
        {points.length === 0 && <p className="hint">No points yet — search an address or click the map.</p>}
        <ul className="point-list">
          {points.map((p, i) => (
            <li key={p.id}>
              <span className="dot" style={{ background: PERSON_COLORS[i % PERSON_COLORS.length] }} />
              <span className="point-label" title={p.label}>
                {shortLabel(p.label)}
              </span>
              <button className="remove" onClick={() => removePoint(p.id)} title="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>

        <button className="primary" onClick={calculate} disabled={points.length < 2 || busy}>
          {busy ? 'Calculating…' : 'Find meeting points'}
        </button>
        {points.length < 2 && <p className="hint">Add at least two homes to calculate.</p>}
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}

        {centers.length > 0 && (
          <div className="results">
            <h2>Results</h2>
            <p className="hint">Click a result to draw everyone&apos;s travel lines on the map.</p>
            {centers.map((c) => (
              <div
                key={c.kind}
                className={`result-card ${selected === c.kind ? 'selected' : ''}`}
                style={selected === c.kind ? { borderColor: c.color } : undefined}
                onClick={() => setSelected(c.kind)}
              >
                <div className="result-head">
                  <span className="center-badge small" style={{ background: c.color }}>
                    {c.badge}
                  </span>
                  <b>{c.title}</b>
                </div>
                <p className="result-desc">{c.description}</p>
                {c.times && (
                  <table className="times">
                    <tbody>
                      {points.map((p, i) => (
                        <tr key={p.id}>
                          <td>
                            <span
                              className="dot"
                              style={{ background: PERSON_COLORS[i % PERSON_COLORS.length] }}
                            />
                            {shortLabel(p.label)}
                          </td>
                          <td className="time">{formatDuration(c.times![i])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}

        <footer>
          Geocoding © OpenStreetMap/Nominatim · Routing © Project OSRM demo server
        </footer>
      </aside>
      <div className="map" ref={mapDivRef} />
    </div>
  )
}
