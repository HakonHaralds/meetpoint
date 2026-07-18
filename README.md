# Meetpoint

Find where a group of friends should meet. Add everyone's home (address search
or click the map), then calculate:

- **Geographic center** — straight-line centroid and geometric median
- **Driving centers** — fastest overall, fairest (shortest longest-drive), and
  equal drive time for everyone, scored with real road travel times

Click any result to draw everyone's travel lines on the map.

Live at [meet.hakonvidir.is](https://meet.hakonvidir.is).

## Stack

React + TypeScript + Vite + Leaflet. Geocoding by
[Nominatim](https://nominatim.org) (OpenStreetMap), routing by the
[Project OSRM](https://project-osrm.org) demo server — both keyless public
services with fair-use policies, so be gentle.

## Develop

```sh
yarn install
yarn dev
```

Deployed to GitHub Pages automatically on push to `main`.
