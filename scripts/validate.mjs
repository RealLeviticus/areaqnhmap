#!/usr/bin/env node
/**
 * Checks the live forecast against the zone geometry and reports anything the
 * map cannot draw correctly.
 *
 *   node scripts/validate.mjs [--url http://127.0.0.1:8080]
 *
 * Three things can go wrong between BOM's words and the drawn chart:
 *   1. a clause we can't parse at all,
 *   2. a named point we can't resolve to coordinates, so a dividing line is
 *      missing or too short,
 *   3. zones that don't tile their area -- a sample point matching no rule
 *      (a gap) means part of the area would be drawn with no QNH at all.
 *
 * Exits non-zero if any of those are found, so it can gate a deploy.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

import {
  samplePts, extendLine, ruleIndexForPoint, resolveRulePolygons,
} from '../public/js/geometry.js';
import { REGIONS } from '../src/screenshots.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const BASE = urlFlag >= 0 ? args[urlFlag + 1] : 'http://127.0.0.1:8080';

const readJSON = async p => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

// ---- inputs ---------------------------------------------------------------

const areas = await readJSON('public/data/areas.json');
const vfr = await readJSON('public/data/vfr_fallback.json');

const forecastRes = await fetch(`${BASE}/api/qnh`);
if (!forecastRes.ok) {
  console.error(`Could not read ${BASE}/api/qnh (HTTP ${forecastRes.status}). Is the server running?`);
  process.exit(2);
}
const forecast = await forecastRes.json();

/** Same lookup table the browser builds, assembled without a DOM. */
const navPoints = new Map();
try {
  const xml = await (await fetch(`${BASE}/api/airspace`)).text();
  const $ = cheerio.load(xml, { xmlMode: true });

  $('Point[Name]').each((_, el) => {
    const coord = parseCoord($(el).text());
    if (coord) navPoints.set($(el).attr('Name').toUpperCase(), coord);
  });
  $('Airport').each((_, el) => {
    const coord = parseCoord($(el).attr('Position') || $(el).text());
    if (!coord) return;
    for (const attr of ['ICAO', 'Name', 'FullName']) {
      const v = $(el).attr(attr);
      if (v) navPoints.set(v.toUpperCase(), coord);
    }
  });
} catch (err) {
  console.warn(`airspace dataset unavailable (${err.message}); using the VFR fallback alone`);
}
for (const [code, coord] of Object.entries(vfr)) {
  if (!navPoints.has(code.toUpperCase())) navPoints.set(code.toUpperCase(), coord);
}

// ---- helpers mirroring public/js/map.js -----------------------------------

function dms(value) {
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

const CLAUSE_NOISE = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'OF', 'TO', 'FROM', 'AND']);
const tokenize = text => text.split(/[\s/]+/)
  .map(t => t.replace(/[.,;]+$/, '').trim())
  .filter(t => t && !CLAUSE_NOISE.has(t.toUpperCase()));

function resolveToken(token) {
  const t = token.trim().toUpperCase();
  const degOnly = /^(\d{1,2})([NS])(\d{1,3})([EW])$/.exec(t);
  if (degOnly) {
    return [(degOnly[4] === 'W' ? -1 : 1) * +degOnly[3], (degOnly[2] === 'S' ? -1 : 1) * +degOnly[1]];
  }
  const degMin = /^(\d{1,2})(\d{2})([NS])(\d{1,3})(\d{2})([EW])$/.exec(t);
  if (degMin) {
    return [
      (degMin[6] === 'W' ? -1 : 1) * (+degMin[4] + +degMin[5] / 60),
      (degMin[3] === 'S' ? -1 : 1) * (+degMin[1] + +degMin[2] / 60),
    ];
  }
  return navPoints.get(t) ?? null;
}

const ringFor = code =>
  areas.features.find(f => f.properties.area_code === `AREA-${code}`)?.geometry.coordinates[0];

// ---- checks ---------------------------------------------------------------

const problems = [];
const notes = [];
let splitAreas = 0;

for (const area of Object.values(forecast.areas)) {
  const ring = ringFor(area.area);
  if (!ring) {
    problems.push(`AREA ${area.area}: BOM forecasts this area but there is no polygon for it`);
    continue;
  }

  for (const rule of area.rules) {
    if (rule.type === 'unparsed') {
      problems.push(`AREA ${area.area}: could not parse clause "${rule.text}"`);
    }
  }

  const valued = area.rules.filter(r => typeof r.qnh === 'number');
  if (valued.length <= 1) continue;
  splitAreas++;

  // Resolve every dividing line, reporting unknown identifiers.
  const geoms = area.rules.map(rule => {
    const geom = { lhs: null, rhs: null };
    const build = text => {
      const tokens = tokenize(text ?? '');
      const coords = [];
      for (const token of tokens) {
        const coord = resolveToken(token);
        if (coord) coords.push(coord);
        else problems.push(`AREA ${area.area}: unknown point "${token}" in "${text}"`);
      }
      if (coords.length === 1) {
        problems.push(`AREA ${area.area}: "${text}" resolved to a single point, so no line can be drawn`);
      }
      return coords.length >= 2 ? extendLine(coords, ring) : null;
    };

    if (rule.type === 'of') geom.lhs = build(rule.lhs);
    if (rule.type === 'between') { geom.lhs = build(rule.lhs); geom.rhs = build(rule.rhs); }

    const resolved = resolveRulePolygons(rule, geom, ring);
    // A divider that can't be turned into polygons means we fell back to the
    // half-plane test, which is only correct for a straight line.
    if ((rule.type === 'of' || rule.type === 'between') && !resolved.polys.length && geom.lhs) {
      notes.push(`AREA ${area.area}: "${describe(rule)}" could not be cut into polygons; using the half-plane fallback`);
    }
    return resolved;
  });

  // Every sample point must land in exactly one zone, and every zone that has a
  // QNH must end up with somewhere to put its label.
  const samples = samplePts(ring, 120);
  const counts = new Array(area.rules.length).fill(0);
  let unassigned = 0;

  for (const pt of samples) {
    const index = ruleIndexForPoint(pt, area.rules, geoms);
    if (index < 0) unassigned++;
    else counts[index]++;
  }

  if (unassigned) {
    const pct = (unassigned / samples.length * 100).toFixed(1);
    problems.push(`AREA ${area.area}: ${pct}% of the area matches no rule, so it would render blank`);
  }

  area.rules.forEach((rule, i) => {
    if (typeof rule.qnh !== 'number') return;
    if (counts[i] === 0) {
      problems.push(
        `AREA ${area.area}: the ${describe(rule)} zone (QNH ${rule.qnh}) is empty, so its value never appears`);
    } else if (counts[i] / samples.length < 0.01) {
      notes.push(
        `AREA ${area.area}: the ${describe(rule)} zone (QNH ${rule.qnh}) covers only ` +
        `${(counts[i] / samples.length * 100).toFixed(1)}% of the area`);
    }
  });
}

/**
 * Every area must appear in full in at least one chart.
 *
 * Being clipped in one region is fine -- that is what the regional crops are
 * for -- but an area that is cut off in all four can never be read properly,
 * which is how Area 24 (which reaches 163E, further east than any region went)
 * slipped through.
 */
function checkRegionCoverage() {
  for (const feature of areas.features) {
    const code = feature.properties.area_code.replace('AREA-', '');
    const ring = feature.geometry.coordinates[0];

    let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
    for (const [lon, lat] of ring) {
      w = Math.min(w, lon); e = Math.max(e, lon);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }

    const fits = Object.entries(REGIONS).filter(([, region]) => {
      const [[rw, rs], [re, rn]] = region.bounds;
      return w >= rw && e <= re && s >= rs && n <= rn;
    });

    if (!fits.length) {
      problems.push(
        `AREA ${code}: clipped in every chart (spans ${w.toFixed(1)}E-${e.toFixed(1)}E, ` +
        `${s.toFixed(1)}-${n.toFixed(1)}); widen a region in src/screenshots.js`);
    }
  }
}

checkRegionCoverage();

function describe(rule) {
  if (rule.type === 'of') return `${rule.dir} OF ${rule.lhs}`;
  if (rule.type === 'between') return `BETWEEN ${rule.lhs} AND ${rule.rhs}`;
  return rule.type.toUpperCase();
}

// ---- report ---------------------------------------------------------------

const orphanPolygons = areas.features
  .map(f => f.properties.area_code.replace('AREA-', ''))
  .filter(code => !forecast.areas[code]);

console.log(`Forecast issued ${forecast.issued}`);
console.log(`  areas forecast:   ${Object.keys(forecast.areas).length}`);
console.log(`  polygons defined: ${areas.features.length}`);
console.log(`  subdivided areas: ${splitAreas}`);
console.log(`  waypoints known:  ${navPoints.size}`);

if (orphanPolygons.length) {
  console.log(`\nPolygons with no forecast this cycle: ${orphanPolygons.join(', ')}`);
}

if (notes.length) {
  console.log('\nNotes:');
  for (const n of notes) console.log(`  - ${n}`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  ! ${p}`);
  process.exit(1);
}

console.log('\nAll areas resolve and tile cleanly.');
