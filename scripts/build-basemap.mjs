#!/usr/bin/env node
/**
 * Regenerates public/data/basemap.json from Natural Earth.
 *
 * The map deliberately bundles its own coastline instead of pulling raster tiles
 * from a provider. BOM's own Area QNH chart is just a coastline outline, so the
 * extra detail a tile provider gives us is wasted -- and every free tile provider
 * we tried (Carto most recently) eventually starts demanding an API key.
 * Bundling the geometry means the map can never be gated or rate-limited.
 *
 * Run this only when you want to refresh the source data; the output is committed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/basemap.json');

// Everything the Australian FIR touches, plus enough of the neighbours that the
// edges of the map don't look truncated.
const BBOX = { minLon: 100, minLat: -50, maxLon: 172, maxLat: -4 };
const PRECISION = 3; // ~110 m at the equator; far finer than this map ever renders

const SOURCES = {
  land: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
  states: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson',
};

async function getJSON(url) {
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const round = n => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;

function ringInBBox(ring) {
  return ring.some(([lon, lat]) =>
    lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat);
}

/** Drop consecutive duplicate points left behind by rounding. */
function dedupe(coords) {
  const out = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c);
  }
  return out;
}

const roundRing = ring => dedupe(ring.map(([lon, lat]) => [round(lon), round(lat)]));

/** Keep only the parts of a feature that fall in our window. */
function clipGeometry(geom) {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.filter(ringInBBox).map(roundRing).filter(r => r.length >= 4);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map(poly => poly.filter(ringInBBox).map(roundRing).filter(r => r.length >= 4))
      .filter(poly => poly.length);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  if (geom.type === 'LineString') {
    if (!ringInBBox(geom.coordinates)) return null;
    const line = roundRing(geom.coordinates);
    return line.length >= 2 ? { type: 'LineString', coordinates: line } : null;
  }
  if (geom.type === 'MultiLineString') {
    const lines = geom.coordinates.filter(ringInBBox).map(roundRing).filter(l => l.length >= 2);
    return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
  }
  return null;
}

function collect(fc, keep = () => true) {
  const features = [];
  for (const f of fc.features ?? []) {
    if (!keep(f.properties ?? {})) continue;
    const geometry = clipGeometry(f.geometry ?? {});
    if (geometry) features.push({ type: 'Feature', properties: {}, geometry });
  }
  return { type: 'FeatureCollection', features };
}

// The bbox reaches far enough north to catch Indonesian and Papuan provincial
// borders, which are just noise on an Australian chart.
const australianOnly = p => p.adm0_a3 === 'AUS' || p.ADM0_A3 === 'AUS';

const [landRaw, statesRaw] = await Promise.all([getJSON(SOURCES.land), getJSON(SOURCES.states)]);

const basemap = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'Natural Earth 1:50m (public domain) via github.com/nvkelso/natural-earth-vector',
  bbox: [BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat],
  land: collect(landRaw),
  states: collect(statesRaw, australianOnly),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(basemap));

const kb = n => `${(n / 1024).toFixed(0)} KB`;
process.stderr.write(
  `wrote ${OUT}\n` +
  `  land:   ${basemap.land.features.length} features\n` +
  `  states: ${basemap.states.features.length} features\n` +
  `  size:   ${kb(JSON.stringify(basemap).length)}\n`);
