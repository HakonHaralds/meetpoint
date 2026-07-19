import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import {
  geocode,
  reverseGeocode,
  driveDurations,
  driveRoute,
  findVenues,
  type GeocodeResult,
  type Venue,
} from './api'
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

const PERSON_COLORS = ['#fb7185', '#60a5fa', '#4ade80', '#fbbf24', '#c084fc', '#22d3ee', '#f472b6']

const CENTER_STYLE: Record<CenterKind, { title: string; description: string; color: string; badge: string }> = {
  centroid: {
    title: 'Geographic center',
    description: 'Average of all positions (straight-line centroid).',
    color: '#38bdf8',
    badge: 'G',
  },
  median: {
    title: 'Straight-line fair point',
    description: 'Minimizes the total straight-line distance for the group.',
    color: '#a78bfa',
    badge: 'M',
  },
  fastest: {
    title: 'Driving — fastest overall',
    description: 'Minimizes the sum of everyone’s drive times.',
    color: '#34d399',
    badge: 'D',
  },
  fairest: {
    title: 'Driving — fairest',
    description: 'Minimizes the longest single drive.',
    color: '#fbbf24',
    badge: 'F',
  },
  equal: {
    title: 'Driving — equal time',
    description: 'Everyone drives about the same time (best effort, favoring closer spots).',
    color: '#f472b6',
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

interface CenterStats {
  total: number
  worst: number
  spread: number
}

function statsOf(times: (number | null)[] | null): CenterStats | null {
  if (!times || times.length === 0 || times.some((t) => t == null)) return null
  const ts = times as number[]
  const total = ts.reduce((a, b) => a + b, 0)
  const worst = Math.max(...ts)
  return { total, worst, spread: worst - Math.min(...ts) }
}

const VENUE_EMOJI: Record<string, string> = {
  cafe: '☕',
  bar: '🍸',
  pub: '🍺',
  restaurant: '🍽️',
  fast_food: '🍔',
}

/** Encode the current points into a shareable URL (base64url in the hash). */
function encodeShareUrl(points: HomePoint[]): string {
  const data = points.map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5)), p.label])
  const bytes = new TextEncoder().encode(JSON.stringify(data))
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${location.origin}${location.pathname}#p=${b64}`
}

function decodeShareHash(hash: string): HomePoint[] | null {
  const m = hash.match(/[#&]p=([A-Za-z0-9_-]+)/)
  if (!m) return null
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = JSON.parse(new TextDecoder().decode(bytes)) as [number, number, string][]
    if (!Array.isArray(data) || data.length === 0) return null
    return data.map(([lat, lon, label], i) => ({
      id: `shared-${i}`,
      lat: Number(lat),
      lon: Number(lon),
      label: String(label),
    }))
  } catch {
    return null
  }
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
  const [points, setPoints] = useState<HomePoint[]>(
    () => decodeShareHash(location.hash) ?? loadPoints(),
  )
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [clickMode, setClickMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [centers, setCenters] = useState<CenterResult[]>([])
  const [selected, setSelected] = useState<CenterKind | null>(null)
  const [venues, setVenues] = useState<Venue[]>([])
  const [venuesBusy, setVenuesBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const mapRef = useRef<L.Map | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const homeLayerRef = useRef<L.LayerGroup | null>(null)
  const centerLayerRef = useRef<L.LayerGroup | null>(null)
  const linesLayerRef = useRef<L.LayerGroup | null>(null)
  const venueLayerRef = useRef<L.LayerGroup | null>(null)
  const radarMarkerRef = useRef<L.Marker | null>(null)
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
    const map = L.map(mapDivRef.current, { zoomControl: false }).setView([64.13, -21.9], 11)
    L.control.zoom({ position: 'topright' }).addTo(map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map)
    // Labels in their own pane: brightened via CSS to near-white and rendered
    // above the route lines so street names stay readable.
    const labelsPane = map.createPane('labels')
    labelsPane.style.zIndex = '450'
    labelsPane.style.pointerEvents = 'none'
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      pane: 'labels',
    }).addTo(map)
    if (import.meta.env.DEV) (window as unknown as { _map?: L.Map })._map = map
    linesLayerRef.current = L.layerGroup().addTo(map)
    homeLayerRef.current = L.layerGroup().addTo(map)
    centerLayerRef.current = L.layerGroup().addTo(map)
    venueLayerRef.current = L.layerGroup().addTo(map)

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
      const icon = L.divIcon({
        className: '',
        html: `<div class="home-pin" style="--c:${color}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      })
      L.marker([p.lat, p.lon], { icon }).bindTooltip(shortLabel(p.label)).addTo(layer)
    })
    if (points.length > 0 && mapRef.current) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]))
      mapRef.current.flyToBounds(bounds.pad(0.3), { maxZoom: 14, duration: 0.8 })
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
        html: `<div class="center-badge" style="--c:${c.color}">${c.badge}</div>`,
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
          opacity: 0.65,
          dashArray: '6 8',
          className: 'dash-line',
        },
      )
        .bindTooltip(tooltip)
        .addTo(layer)

    const drawRoute = (coords: [number, number][], i: number, tooltip: string) => {
      const color = PERSON_COLORS[i % PERSON_COLORS.length]
      L.polyline(coords, { color, weight: 11, opacity: 0.16, interactive: false }).addTo(layer)
      const line = L.polyline(coords, { color, weight: 4, opacity: 0.95, className: 'route-line' })
        .bindTooltip(tooltip)
        .addTo(layer)
      // Animate the route being drawn from home to destination.
      const el = line.getElement() as SVGPathElement | null
      if (el?.getTotalLength) {
        const len = el.getTotalLength()
        el.style.strokeDasharray = `${len}`
        el.style.strokeDashoffset = `${len}`
        void el.getBoundingClientRect()
        el.style.transition = 'stroke-dashoffset 0.9s ease-out'
        el.style.strokeDashoffset = '0'
      }
    }

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
        drawRoute(coords, i, tooltip)
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

  // Venue markers on the map.
  useEffect(() => {
    const layer = venueLayerRef.current
    if (!layer) return
    layer.clearLayers()
    for (const v of venues) {
      const icon = L.divIcon({
        className: '',
        html: `<div class="venue-pin">${VENUE_EMOJI[v.kind] ?? '📍'}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      })
      L.marker([v.lat, v.lon], { icon }).bindTooltip(v.name).addTo(layer)
    }
  }, [venues])

  // Venues belong to one selected center; clear them when the context changes.
  useEffect(() => {
    setVenues([])
  }, [selected, centers])

  async function locateVenues(c: CenterResult) {
    if (venuesBusy) return
    setVenuesBusy(true)
    setError('')
    try {
      const found = await findVenues(c)
      found.sort((a, b) => haversine(c, a) - haversine(c, b))
      setVenues(found.slice(0, 12))
      if (found.length === 0) setError('No named venues within 700 m of this spot.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setVenuesBusy(false)
    }
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(encodeShareUrl(points))
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setError('Could not copy — your browser blocked clipboard access.')
    }
  }

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

    // Radar pulse over the search area while drive times are being fetched.
    if (mapRef.current) {
      const radarIcon = L.divIcon({
        className: '',
        html: '<div class="radar"><span></span><span></span></div>',
        iconSize: [80, 80],
        iconAnchor: [40, 40],
      })
      radarMarkerRef.current = L.marker([median.lat, median.lon], {
        icon: radarIcon,
        interactive: false,
      }).addTo(mapRef.current)
    }

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
      radarMarkerRef.current?.remove()
      radarMarkerRef.current = null
      setBusy(false)
    }
  }

  const allStats = new Map<CenterKind, CenterStats | null>(centers.map((c) => [c.kind, statsOf(c.times)]))
  const bestOf = (key: keyof CenterStats) => {
    const vals = [...allStats.values()].filter((s): s is CenterStats => s !== null).map((s) => s[key])
    return vals.length ? Math.min(...vals) : null
  }
  const best: Record<keyof CenterStats, number | null> = {
    total: bestOf('total'),
    worst: bestOf('worst'),
    spread: bestOf('spread'),
  }

  return (
    <div className="app">
      <div className="map" ref={mapDivRef} />
      <aside className="panel">
        <header className="brand">
          <span className="logo">📍</span>
          <div>
            <h1>Meetpoint</h1>
            <p className="subtitle">Find the middle — fair and square.</p>
          </div>
        </header>

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

        <div className="section-row">
          <h2>Homes ({points.length})</h2>
          {points.length > 0 && (
            <button className="ghost" onClick={copyShareLink}>
              {copied ? '✓ Link copied!' : '🔗 Copy share link'}
            </button>
          )}
        </div>
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
        {status && (
          <p className="status">
            <span className="spinner" />
            {status}
          </p>
        )}
        {error && <p className="error">{error}</p>}

        {centers.length > 0 && (
          <div className="results">
            <h2>Results</h2>
            <p className="hint">Click a result to draw everyone&apos;s travel lines on the map.</p>
            {centers.map((c) => {
              const s = allStats.get(c.kind) ?? null
              return (
                <div
                  key={c.kind}
                  className={`result-card ${selected === c.kind ? 'selected' : ''}`}
                  style={{ ['--c' as string]: c.color }}
                  onClick={() => setSelected(c.kind)}
                >
                  <div className="result-head">
                    <span className="center-badge small" style={{ background: c.color }}>
                      {c.badge}
                    </span>
                    <b>{c.title}</b>
                  </div>
                  <p className="result-desc">{c.description}</p>
                  {s && (
                    <div className="chips">
                      <span className={`chip ${s.total === best.total ? 'best' : ''}`}>
                        Total {formatDuration(s.total)}
                      </span>
                      <span className={`chip ${s.worst === best.worst ? 'best' : ''}`}>
                        Longest {formatDuration(s.worst)}
                      </span>
                      <span className={`chip ${s.spread === best.spread ? 'best' : ''}`}>
                        Gap {formatDuration(s.spread)}
                      </span>
                    </div>
                  )}
                  {selected === c.kind && (
                    <div className="venues" onClick={(e) => e.stopPropagation()}>
                      <button className="ghost" onClick={() => locateVenues(c)} disabled={venuesBusy}>
                        {venuesBusy ? 'Searching…' : '☕ Find venues nearby'}
                      </button>
                      {venues.length > 0 && (
                        <ul className="venue-list">
                          {venues.map((v) => (
                            <li key={`${v.name}-${v.lat}`}>
                              <button
                                onClick={() => mapRef.current?.flyTo([v.lat, v.lon], 16, { duration: 0.6 })}
                              >
                                <span>{VENUE_EMOJI[v.kind] ?? '📍'}</span>
                                <span className="venue-name">{v.name}</span>
                                <span className="venue-dist">{Math.round(haversine(c, v))} m</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
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
              )
            })}
          </div>
        )}

        <footer>
          Geocoding © OpenStreetMap/Nominatim · Routing © Project OSRM · Tiles © CARTO
        </footer>
      </aside>
    </div>
  )
}
