# Area QNH Map

A map of the Australian Area QNH forecast, built from the Bureau of Meteorology's
public Area QNH page.

Live at **https://areaqnh.actuallyleviticus.xyz**

> **Not for operational use.** This is an unofficial visualisation. Always check
> the Bureau or NAIPS before flight.

---

## Why this exists

BOM publishes Area QNH as **text only** on its public site — a list of areas and
hectopascal values, with subdivisions written in prose:

```
AREA 45: SE OF YGTN/YCKN 1022,
         BETWEEN YCOE/YCRY AND YGTN/YCKN 1019,
         REST 1016
```

BOM *does* produce a graphical version, but it is not public. The chart lives
behind `https://www.bom.gov.au/products/reg/aviation/area-qnh/`, which returns
**401** without a registered-user login, and the raw `IDY40000`–`IDY40007` text
products are not served publicly either. Airservices distributes the chart
through NAIPS. So if you want to *see* Area QNH on a map without logging in,
something has to draw it — that is what this does.

## How it works

One Node process does everything:

```
BOM Area QNH page ──┐
                    ├─→ parse + cache ──→ /api/qnh (JSON)
vatSys airspace ────┘                     /api/airspace (XML)
                                                │
                                                ▼
                          public/ ─── MapLibre draws the chart
                                                │
                                                ▼
                          Puppeteer screenshots → /images/qnh-*.png
```

* **`src/bom.js`** turns BOM's HTML into structured JSON. It parses the page's
  actual markup (one `<div>` per state, each with its own `Valid:`/`Issued:`
  stamps) rather than flattening it to text, which is what keeps per-state issue
  times correct when BOM amends a single state.
* **`src/upstream.js`** keeps one cached copy of each feed, refreshed on a timer.
  BOM is polled every five minutes regardless of how many people are looking,
  and the last good forecast keeps being served if BOM goes down.
* **`public/js/geometry.js`** works out where each subdivision actually is. This
  is the interesting part — see below.
* **`src/screenshots.js`** renders the map to PNGs whenever the forecast
  changes, pointing a headless browser at this same server.

### Drawing the subdivisions

BOM names a dividing line by the points it passes through (`N OF PVS/MSTM/YPBO`).
To colour the map we need to know which side of that line every point is on.

The line is first **extended** at both ends until it meets the area boundary, so
it genuinely cuts the area in two. Then `splitRingByLine()` builds the two
resulting polygons explicitly, and membership is an ordinary point-in-polygon
test.

The obvious shortcut — check which side of the *nearest segment* a point is on —
is wrong for a divider that bends. Area 68's divider runs west and then turns
south; for a point past the bend the nearest segment is the southbound leg,
whose sides have nothing to do with "north". That put two labels in the same
region. `test/geometry.test.js` pins this down.

Rules are applied **in the order BOM writes them** (most specific first, `REST`
last), and each sample point is assigned to exactly one rule — so the zones tile
the area with no gaps and no overlaps by construction.

### No third-party map dependencies

The basemap coastline (`public/data/basemap.json`, from Natural Earth) and the
map font (`public/fonts/`) are **committed to this repo**, and MapLibre is served
from `node_modules`. Nothing is fetched from a tile provider or a CDN at runtime.

This is deliberate. Earlier versions used Carto raster tiles, which now require
an API key, and glyphs from MapLibre's demo server. BOM's own chart is just a
coastline with annotations, so there is nothing to gain from a tile provider and
a working site to lose when one changes its terms.

To refresh the coastline: `npm run build:basemap`.

## Running it

```bash
npm install
npm start           # http://localhost:8080
```

Rendering the chart images locally needs a Chromium binary:

```bash
CHROME_PATH="/path/to/chrome" npm start
CHROME_PATH="/path/to/chrome" npm run shoot -- --force   # render once, now
```

Set `SCREENSHOTS_ENABLED=0` to run the site without rendering images at all.

### Checks

```bash
npm test                    # parser and geometry unit tests
node scripts/validate.mjs   # check the LIVE forecast against the geometry
```

`validate.mjs` is the one to run when something looks wrong on the map. It
reports clauses it could not parse, waypoints it could not resolve, and any area
whose zones fail to tile — and exits non-zero, so it can gate a deploy.

## Endpoints

| Path | What it is |
| --- | --- |
| `/` | the live map |
| `/static.html` | pre-rendered charts, one per tab |
| `/images/qnh-{au,wa,se,ne}.png` | the chart images — **this is what vatSys loads** |
| `/api/qnh` | the parsed forecast as JSON |
| `/api/airspace` | the cached vatSys airspace dataset |
| `/api/status` | feed freshness and image render times |
| `/healthz` | liveness probe |

The image URLs are stable and CORS-open; nothing else needs to change for a
client that just wants a PNG.

## Deployment

Runs as a single container on the VPS, behind the host's Caddy, with Cloudflare
proxying DNS in front.

```bash
ssh ozserver-api
sudo mkdir -p /opt/areaqnhmap && sudo chown ubuntu:ubuntu /opt/areaqnhmap
git clone https://github.com/RealLeviticus/areaqnhmap /opt/areaqnhmap
cd /opt/areaqnhmap && docker compose up -d --build
```

Then add the block from `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`
and `sudo systemctl reload caddy`.

### Auto-deploy

A systemd timer polls `origin/main` every two minutes and redeploys when it
moves. It is health-gated: if the new build doesn't answer `/healthz` within
about a minute it rolls back to the previous commit and rebuilds, so a bad push
leaves the old version running rather than taking the map down.

```bash
sudo cp deploy/areaqnhmap-deploy /usr/local/bin/ && sudo chmod +x /usr/local/bin/areaqnhmap-deploy
sudo cp deploy/areaqnhmap-deploy.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now areaqnhmap-deploy.timer
```

Check on it with `systemctl status areaqnhmap-deploy` or
`journalctl -u areaqnhmap-deploy -n 50`.

## Configuration

Everything has a working default; `.env` is optional. See `.env.example` for the
full list — the ones worth knowing are `PORT`, `DATA_DIR`,
`SCREENSHOTS_ENABLED` and `QNH_REFRESH_MS`.

## History

Version 2 replaced a setup spread across GitHub Pages, three Cloudflare Workers,
an R2 bucket and an hourly GitHub Actions job. Two of those Workers existed only
to add CORS headers to someone else's data, which stops being a problem once the
page and the fetcher share an origin. The Actions job committed a timestamp file
back to the repo on every run, which is where ~2,000 of the repo's 2,165 commits
came from; that history was rewritten when the job was removed.

If you are taking this over: you need a VPS with Docker. That is the whole list.
