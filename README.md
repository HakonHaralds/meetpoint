# Meetpoint

Find where a group of friends should meet. Add everyone's home (address search
or click the map), then calculate five candidate meeting points:

- **Geographic center** (G) — straight-line centroid
- **Straight-line fair point** (M) — geometric median (Weiszfeld's algorithm),
  minimizes total straight-line distance
- **Driving — fastest overall** (D) — minimizes the sum of drive times
- **Driving — fairest** (F) — minimizes the longest single drive
- **Driving — equal time** (E) — minimizes the gap between longest and
  shortest drive, with a small mean-time penalty so it prefers the *closest*
  point on the equal-time locus

Clicking a result draws everyone's travel lines (straight dashed lines for
G/M, animated real road routes for D/F/E), shows comparison chips
(Total / Longest / Gap, best across results highlighted), and offers a
venue finder for actual cafés/bars/restaurants near the spot. Setups can be
shared as URLs. Live at **[meet.hakonvidir.is](https://meet.hakonvidir.is)**.

## Architecture

React 18 + TypeScript + Vite 5 + Leaflet, fully static — every API call
happens in the browser against free, keyless public services:

| Service | Used for | Notes |
|---|---|---|
| [Nominatim](https://nominatim.org) | Address search, reverse geocoding | fair-use policy, be gentle |
| [OSRM demo server](https://project-osrm.org) | Drive-time matrices (`/table`), route geometry (`/route`) | driving profile only |
| [Overpass API](https://overpass-api.de) | Venue finder (amenity nodes/ways near a point) | |
| [CARTO basemaps](https://carto.com/attributions) | `dark_nolabels` base + `dark_only_labels` in a separate pane, brightened to white via CSS filter and rendered above route lines | |

Source layout (`src/`):

- `geo.ts` — haversine, spherical centroid, geometric median (Weiszfeld in a
  local planar projection), candidate-grid generation
- `api.ts` — Nominatim / OSRM / Overpass clients
- `drivingCenter.ts` — the driving-center search: one 7×7 seed grid covering
  all homes scored via an OSRM travel-time matrix, then two per-criterion
  refinement grids zooming in on each criterion's best candidate
  (~7 matrix requests per calculation, ~200 m final resolution)
- `App.tsx` — all UI/map state. Points persist in `localStorage`
  (`meetpoint.points`). Share links encode `[lat, lon, label]` tuples as
  base64url JSON in the URL hash (`#p=…`); links generated on localhost
  intentionally point at the production origin.

## Develop

Requires Node ≥18 and yarn (repo currently developed on Node 18.15, which is
why Vite is pinned to v5 — Vite 6+ needs Node 20).

```sh
yarn install
yarn dev        # http://localhost:5173 (or --port of your choice)
yarn build      # tsc -b && vite build → dist/
```

There is no test suite; verification has been done by driving the app in
headless Chrome (`playwright-core` with `channel: 'chrome'`) through the full
flow: add 3 real addresses → calculate → select each result → check drive
times, route lines, share-link round-trip, and console errors.

## Deploy & hosting

GitHub Pages, branch-based: `./scripts/deploy.sh` builds and force-pushes
`dist/` to the `gh-pages` branch. `public/CNAME` pins the custom domain
`meet.hakonvidir.is`.

DNS: the domain is registered at ISNIC using their "DNS Hýsing ISNIC"
service; the only record is `meet CNAME hakonharalds.github.io.` HTTPS is
enforced (Let's Encrypt via GitHub).

Known operational quirks:

- **Cert provisioning can silently stall** if a custom domain is set while
  DNS doesn't resolve yet. Fix: remove and re-add the domain
  (`gh api repos/<owner>/<repo>/pages -X PUT -F 'cname=null'`, then set it
  again), watch `.https_certificate.state`, and PUT `https_enforced=true`
  once it reads `approved`.
- **CI auto-deploy is prepared but not enabled**: a GitHub Actions workflow
  exists locally at `.github/workflows/deploy.yml` but isn't in the repo
  because the maintainer's OAuth token lacks the `workflow` scope
  (`gh auth refresh -h github.com -s workflow` unlocks it; then commit the
  workflow, switch Pages source to GitHub Actions, and retire
  `scripts/deploy.sh`).

## Privacy

Friends' home locations are deliberately **not** hardcoded anywhere in this
public repo or the deployed site. They live only in users' browser
localStorage and in share links users generate themselves.

## Ideas considered but not (yet) built

Names/avatars per person, PNG share card, PWA install, venue-type presets,
weather at the spot, Google/Apple Maps handoff, per-person travel modes and
isochrone overlap (both need an OpenRouteService key), drive-time heatmap,
animated arrival race, saved groups, light-mode toggle.
