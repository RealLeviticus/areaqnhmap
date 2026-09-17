/**
 * Draws the Area QNH map.
 *
 * Data flow:
 *   /api/qnh       parsed forecast (the server does all BOM parsing)
 *   /api/airspace  vatSys dataset, for resolving waypoint identifiers
 *   data/areas.json    Area QNH zone polygons
 *   data/basemap.json  bundled coastline (see scripts/build-basemap.mjs)
 */
import {
  samplePts, findLabelPos, centroid, extendLine, clipLine,
  findBestZoneLabel, ruleIndexForPoint, resolveRulePolygons,
} from './geometry.js';

const COLOURS = {
  land: '#f4f1ea',
  landOutline: '#9aa5b1',
  stateBorder: '#d5d8dc',
  water: '#dfe8f0',
  area: '#ff0000',
  split: '#1a8f2a',
  text: '#000000',
  halo: '#ffffff',
};

const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
/** Screenshot mode hides the chrome so the rendered PNG is just the chart. */
const IS_SCREENSHOT = params.get('screenshot') === '1' || params.get('capture') === '1';

let map;
let areaGeoJSON;
let forecast = null;
/** Uppercased identifier -> [lon, lat] */
const navPoints = new Map();

// ---------------------------------------------------------------------------
// Basemap
// ---------------------------------------------------------------------------

/**
 * The style is built entirely from files we ship.
 *
 * Earlier versions pulled raster tiles from Carto, which now wants an API key,
 * and glyphs from MapLibre's demo server. Both the coastline and the font are
 * now committed to this repo, so there is nothing left for a third party to
 * rate-limit, gate or withdraw. BOM's own Area QNH chart is just a coastline
 * with annotations, so no detail is lost by dropping the tile provider.
 */
function buildStyle(basemap) {
  return {
    version: 8,
    // Glyphs are served from public/fonts/, not from a CDN. MapLibre matches
    // the font stack to the directory name, so 'Noto Sans Regular' resolves to
    // fonts/Noto Sans Regular/{range}.pbf. Every label on this map is ASCII,
    // so the single 0-255 range is all we ever need to ship.
    glyphs: 'fonts/{fontstack}/{range}.pbf',
    sources: {
      land: { type: 'geojson', data: basemap.land },
      states: { type: 'geojson', data: basemap.states },
    },
    layers: [
      { id: 'water', type: 'background', paint: { 'background-color': COLOURS.water } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
      {
        id: 'state-borders',
        type: 'line',
        source: 'states',
        paint: { 'line-color': COLOURS.stateBorder, 'line-width': 1 },
      },
      {
        id: 'coastline',
        type: 'line',
        source: 'land',
        paint: { 'line-color': COLOURS.landOutline, 'line-width': 0.8 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Waypoint lookup
// ---------------------------------------------------------------------------

/** vatSys encodes coordinates as packed DDMMSS, e.g. "-331234+1502345". */
function dms(value) {
  if (!value) return NaN;
  const sign = value.trim().startsWith('-') ? -1 : 1;
  const n = Math.abs(parseFloat(value));
  const deg = Math.floor(n / 10000);
  const rest = n - deg * 10000;
  const min = Math.floor(rest / 100);
  return sign * (deg + min / 60 + (rest - min * 100) / 3600);
}

function parseCoord(raw) {
  if (!raw) return null;
  const parts = raw.split(/(?=[+-]\d)/).filter(Boolean);
  if (parts.length !== 2) return null;
  const lat = dms(parts[0]);
  const lon = dms(parts[1]);
  return (Number.isFinite(lat) && Number.isFinite(lon)) ? [lon, lat] : null;
}

async function loadNavPoints() {
  // The airspace dataset is large and optional; the VFR fallback covers the
  // identifiers BOM actually uses, so a failure here is not fatal.
  try {
    const res = await fetch('/api/airspace');
    if (res.ok) {
      const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');

      for (const node of doc.querySelectorAll('Point[Name]')) {
        const coord = parseCoord(node.textContent);
        if (coord) navPoints.set(node.getAttribute('Name').toUpperCase(), coord);
      }

      for (const node of doc.querySelectorAll('Airport')) {
        const coord = parseCoord(node.getAttribute('Position') || node.textContent);
        if (!coord) continue;
        for (const attr of ['ICAO', 'Name', 'FullName']) {
          const value = node.getAttribute(attr);
          if (value) navPoints.set(value.toUpperCase(), coord);
        }
      }
    }
  } catch {
    // fall through to the bundled fallback
  }

  try {
    const res = await fetch('data/vfr_fallback.json');
    if (!res.ok) return;
    for (const [code, coord] of Object.entries(await res.json())) {
      const key = code.toUpperCase();
      if (!navPoints.has(key)) navPoints.set(key, coord);
    }
  } catch {
    // nothing more to try
  }
}

/**
 * Resolve one token from a subdivision clause.
 * Accepts bare lat/long ("33S156E", "3315S15630E") or a named point.
 */
function resolveToken(token) {
  if (!token) return null;
  const t = token.trim().toUpperCase();

  const degOnly = /^(\d{1,2})([NS])(\d{1,3})([EW])$/.exec(t);
  if (degOnly) {
    const lat = (degOnly[2] === 'S' ? -1 : 1) * +degOnly[1];
    const lon = (degOnly[4] === 'W' ? -1 : 1) * +degOnly[3];
    return { coord: [lon, lat], name: t };
  }

  const degMin = /^(\d{1,2})(\d{2})([NS])(\d{1,3})(\d{2})([EW])$/.exec(t);
  if (degMin) {
    const lat = (degMin[3] === 'S' ? -1 : 1) * (+degMin[1] + +degMin[2] / 60);
    const lon = (degMin[6] === 'W' ? -1 : 1) * (+degMin[4] + +degMin[5] / 60);
    return { coord: [lon, lat], name: t };
  }

  const coord = navPoints.get(t);
  return coord ? { coord, name: t } : null;
}

const CLAUSE_NOISE = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'OF', 'TO', 'FROM', 'AND']);

function tokenize(text) {
  return text.split(/[\s/]+/)
    .map(t => t.replace(/[.,;]+$/, '').trim())
    .filter(t => t && !CLAUSE_NOISE.has(t.toUpperCase()));
}

const buildCoords = text => tokenize(text).map(resolveToken).filter(Boolean);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ringFor = code =>
  areaGeoJSON.features.find(f => f.properties.area_code === `AREA-${code}`)?.geometry.coordinates[0];

/** Does this area's forecast divide it into more than one value? */
const isSplit = area => area.rules.filter(r => typeof r.qnh === 'number').length > 1;

/**
 * Resolve each rule's dividing line(s) to coordinates, once per area.
 * Returns an array parallel to `rules`.
 */
function buildRuleGeometry(rules, ring) {
  return rules.map(rule => {
    const geom = { lhs: null, rhs: null, points: [] };

    if (rule.type === 'of') {
      const pts = buildCoords(rule.lhs ?? '');
      geom.points.push(...pts);
      if (pts.length >= 2) geom.lhs = extendLine(pts.map(p => p.coord), ring);
    }

    if (rule.type === 'between') {
      const lp = buildCoords(rule.lhs ?? '');
      const rp = buildCoords(rule.rhs ?? '');
      geom.points.push(...lp, ...rp);
      if (lp.length >= 2) geom.lhs = extendLine(lp.map(p => p.coord), ring);
      if (rp.length >= 2) geom.rhs = extendLine(rp.map(p => p.coord), ring);
    }

    // Turn the dividing lines into the actual half-polygons this rule covers,
    // so membership is a point-in-polygon test rather than a guess from the
    // nearest segment (see splitRingByLine in geometry.js).
    return resolveRulePolygons(rule, geom, ring);
  });
}

/** Area outlines plus the label for every undivided area. */
function renderAreas() {
  const labels = [];

  for (const feature of areaGeoJSON.features) {
    const code = feature.properties.area_code.replace('AREA-', '');
    const area = forecast?.areas?.[code];
    if (area && isSplit(area)) continue; // handled by renderSplits

    const single = area?.rules.find(r => typeof r.qnh === 'number');
    labels.push({
      type: 'Feature',
      properties: { qnh: single ? String(single.qnh) : '', area: code },
      geometry: { type: 'Point', coordinates: findLabelPos(feature.geometry.coordinates[0]) },
    });
  }

  setData('area-labels', { type: 'FeatureCollection', features: labels });
}

/** Dividing lines, per-subdivision values, and the points BOM named. */
function renderSplits() {
  const solid = [];
  const dashed = [];
  const marks = [];
  const labels = [];
  const seenMarks = new Set();

  for (const area of Object.values(forecast?.areas ?? {})) {
    if (!isSplit(area)) continue;

    const ring = ringFor(area.area);
    if (!ring) continue;

    const geoms = buildRuleGeometry(area.rules, ring);

    // Dividing lines, and the named points along them.
    for (const geom of geoms) {
      for (const line of [geom.lhs, geom.rhs]) {
        if (!line) continue;
        const clipped = clipLine(line, ring);
        for (const [target, segments] of [[solid, clipped.solid], [dashed, clipped.dashed]]) {
          for (const seg of segments) {
            target.push({
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: seg },
            });
          }
        }
      }

      for (const point of geom.points) {
        const key = `${area.area}|${point.name}`;
        if (seenMarks.has(key)) continue;
        seenMarks.add(key);
        marks.push({
          type: 'Feature',
          properties: { name: point.name },
          geometry: { type: 'Point', coordinates: point.coord },
        });
      }
    }

    // Assign every sample point to exactly one rule, then label each zone.
    // Doing the assignment once (rather than testing each rule independently)
    // is what guarantees the zones tile the area with no overlaps or gaps.
    const samples = samplePts(ring, 200);
    const zones = area.rules.map(() => []);
    for (const pt of samples) {
      const index = ruleIndexForPoint(pt, area.rules, geoms);
      if (index >= 0) zones[index].push(pt);
    }

    const allLines = geoms.flatMap(g => [g.lhs, g.rhs].filter(Boolean));

    area.rules.forEach((rule, i) => {
      if (typeof rule.qnh !== 'number' || !zones[i].length) return;
      const pos = findBestZoneLabel(zones[i], ring, allLines) ?? centroid(zones[i]);
      labels.push({
        type: 'Feature',
        properties: { qnh: String(rule.qnh), area: area.area },
        geometry: { type: 'Point', coordinates: pos },
      });
    });
  }

  setData('split-solid', { type: 'FeatureCollection', features: solid });
  setData('split-dashed', { type: 'FeatureCollection', features: dashed });
  setData('split-marks', { type: 'FeatureCollection', features: marks });
  setData('split-labels', { type: 'FeatureCollection', features: labels });
}

function setData(id, data) {
  const source = map.getSource(id);
  if (source) source.setData(data);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Must match a directory under public/fonts/. */
const FONT = ['Noto Sans Regular'];

function addLayers() {
  map.addSource('areas', { type: 'geojson', data: areaGeoJSON });
  for (const id of ['area-labels', 'split-solid', 'split-dashed', 'split-marks', 'split-labels']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  map.addLayer({
    id: 'area-outline',
    type: 'line',
    source: 'areas',
    paint: { 'line-color': COLOURS.area, 'line-width': 1.6 },
  });

  map.addLayer({
    id: 'split-solid-line',
    type: 'line',
    source: 'split-solid',
    paint: { 'line-color': COLOURS.split, 'line-width': 1.4 },
  });

  map.addLayer({
    id: 'split-dashed-line',
    type: 'line',
    source: 'split-dashed',
    paint: { 'line-color': COLOURS.split, 'line-width': 1.4, 'line-dasharray': [3, 3] },
  });

  map.addLayer({
    id: 'split-mark',
    type: 'circle',
    source: 'split-marks',
    paint: {
      'circle-radius': 2.5,
      'circle-color': COLOURS.split,
      'circle-stroke-width': 1,
      'circle-stroke-color': COLOURS.halo,
    },
  });

  // Undivided areas: QNH in black with the area number beneath it in red,
  // matching how BOM annotates its own chart.
  map.addLayer({
    id: 'split-mark-label',
    type: 'symbol',
    source: 'split-marks',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT,
      'text-size': 9,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#1f6feb', 'text-halo-color': COLOURS.halo, 'text-halo-width': 1.5 },
  });

  map.addLayer({
    id: 'area-label',
    type: 'symbol',
    source: 'area-labels',
    layout: {
      'text-field': ['get', 'qnh'],
      'text-font': FONT,
      'text-size': 15,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': COLOURS.text, 'text-halo-color': COLOURS.halo, 'text-halo-width': 2 },
  });

  map.addLayer({
    id: 'area-label-number',
    type: 'symbol',
    source: 'area-labels',
    layout: {
      'text-field': ['concat', 'AREA ', ['get', 'area']],
      'text-font': FONT,
      'text-size': 10,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': COLOURS.area, 'text-halo-color': COLOURS.halo, 'text-halo-width': 2 },
  });

  // Subdivision values in green, so they read as belonging to the green
  // dividing lines rather than to the area as a whole.
  map.addLayer({
    id: 'split-label',
    type: 'symbol',
    source: 'split-labels',
    layout: {
      'text-field': ['get', 'qnh'],
      'text-font': FONT,
      'text-size': 15,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': COLOURS.split, 'text-halo-color': COLOURS.halo, 'text-halo-width': 2 },
  });

  map.addLayer({
    id: 'split-label-number',
    type: 'symbol',
    source: 'split-labels',
    layout: {
      'text-field': ['concat', 'AREA ', ['get', 'area']],
      'text-font': FONT,
      'text-size': 10,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': COLOURS.area, 'text-halo-color': COLOURS.halo, 'text-halo-width': 2 },
  });
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

const UTC = new Intl.DateTimeFormat('en-AU', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  day: 'numeric', month: 'short', timeZone: 'UTC',
});

const stampUTC = iso => (iso ? `${UTC.format(new Date(iso))} UTC` : '—');

function setStatus(state, text) {
  if (IS_SCREENSHOT) return;
  const dot = $('statusDot');
  if (dot) dot.className = `status-dot ${state}`;
  const label = $('validityText');
  if (label) label.textContent = text;
}

function describeForecast() {
  if (!forecast) return 'No forecast';
  const amd = forecast.amended ? 'AMD ' : '';
  const validity = `${stampUTC(forecast.validFrom)} – ${stampUTC(forecast.validTo)}`;
  return `${amd}Valid ${validity} · Issued ${stampUTC(forecast.issued)}`;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadForecast() {
  setStatus('loading', 'Fetching…');
  try {
    const res = await fetch('/api/qnh');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    forecast = await res.json();

    renderAreas();
    renderSplits();
    setStatus(forecast.stale ? 'error' : '', describeForecast());
  } catch (err) {
    setStatus('error', `Unavailable (${err.message})`);
  }
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function init() {
  if (IS_SCREENSHOT) document.body.classList.add('screenshot');

  const [basemap, areas] = await Promise.all([
    getJSON('data/basemap.json'),
    getJSON('data/areas.json'),
  ]);
  areaGeoJSON = areas;

  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(basemap),
    center: [134, -26],
    zoom: 3.6,
    attributionControl: false,
    // Required for element.screenshot() to capture the WebGL canvas.
    preserveDrawingBuffer: true,
    interactive: !IS_SCREENSHOT,
  });

  if (!IS_SCREENSHOT) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({
      customAttribution:
        'Forecast © Bureau of Meteorology · Coastline: Natural Earth · Not for operational use',
    }), 'bottom-right');
  }

  // Hooks used by the screenshot renderer (src/screenshots.js).
  window.__map = map;
  window.__mapIdle = false;
  window.__fitBounds = bounds => {
    window.__mapIdle = false;
    map.resize();
    map.fitBounds(new maplibregl.LngLatBounds(bounds[0], bounds[1]), { padding: 24, duration: 0 });
  };
  map.on('idle', () => { window.__mapIdle = true; });

  await new Promise(resolve => map.on('load', resolve));

  addLayers();
  await loadNavPoints();
  await loadForecast();

  // Only now is everything the renderer needs actually on screen.
  window.__mapReady = true;

  // BOM issues every three hours; polling every few minutes picks up a new
  // cycle or an amendment without the visitor needing to reload.
  setInterval(loadForecast, 5 * 60 * 1000);
}

init().catch(err => {
  console.error(err);
  setStatus('error', `Failed to start: ${err.message}`);
});
